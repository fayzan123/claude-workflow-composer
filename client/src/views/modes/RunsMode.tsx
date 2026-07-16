import React, { useState, useEffect, useReducer, useRef } from 'react'
import type { RunEvent } from '../../../../src/run-events.ts'
import type { RunSummary } from '../../../../src/server/run-store.ts'
import { api } from '../../lib/api.ts'
import { InboxItem } from '../../components/runs/InboxItem.tsx'
import { SettingsBlock } from '../../components/runs/SettingsBlock.tsx'
import { fmtDuration, fmtRelative, STATUS_LABEL, eventLabel } from '../../components/runs/format.ts'
import { diffLineKind } from '../../lib/diff-lines.ts'
import { INITIAL_RUN_RESULT_ACTION_STATE, runResultActionReducer, type RunResultActionKind } from '../../lib/run-result-actions.ts'
import type { ModeProps } from '../modeProps.ts'
import './RunsMode.css'

// Import RunPanel.css so the inbox/settings/timeline CSS classes still resolve
// (InboxItem and SettingsBlock use run-panel__* class names from that stylesheet)
import '../../components/RunPanel.css'

export function RunsMode({ workflow, runState }: ModeProps) {
  const { runs, liveEvents, activeRun, pausedRuns, refresh } = runState

  // Selected run ID — default to active run, else most recent
  const defaultRunId = activeRun?.runId ?? runs[0]?.runId ?? null
  const [selectedRunId, setSelectedRunId] = useState<string | null>(defaultRunId)
  const [historicalEvents, setHistoricalEvents] = useState<RunEvent[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [diff, setDiff] = useState<{ diff: string | null; status: string | null; branch: string | null; error?: string } | null>(null)
  const [detailRefreshKey, setDetailRefreshKey] = useState(0)
  const [resultAction, dispatchResultAction] = useReducer(runResultActionReducer, INITIAL_RUN_RESULT_ACTION_STATE)
  const pendingResultRuns = useRef(new Map<string, RunResultActionKind>())
  const selectedRunIdRef = useRef(selectedRunId)
  selectedRunIdRef.current = selectedRunId

  // When the run list changes (new run started), update selection if nothing was chosen
  useEffect(() => {
    setSelectedRunId(prev => {
      if (prev !== null) return prev
      return activeRun?.runId ?? runs[0]?.runId ?? null
    })
  }, [activeRun, runs])

  // Keep selection on active run while it is live
  useEffect(() => {
    if (activeRun) {
      setSelectedRunId(activeRun.runId)
    }
  }, [activeRun?.runId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch historical events when a non-active run is selected
  useEffect(() => {
    if (!selectedRunId) return
    const isLive = activeRun?.runId === selectedRunId
    if (isLive) {
      setHistoricalEvents([])
      return
    }
    let cancelled = false
    api.runs.events(workflow.meta.id, selectedRunId).then(evs => {
      if (!cancelled) setHistoricalEvents(evs)
    }).catch(() => {
      if (!cancelled) setHistoricalEvents([])
    })
    return () => { cancelled = true }
  }, [selectedRunId, activeRun?.runId, workflow.meta.id, detailRefreshKey])

  const isLiveView = selectedRunId !== null && activeRun?.runId === selectedRunId
  const timeline: RunEvent[] = isLiveView ? liveEvents : historicalEvents

  const selectedRun: RunSummary | undefined = runs.find(r => r.runId === selectedRunId)

  // Fetch the diff for whatever run is selected (paused, completed, or live).
  useEffect(() => {
    if (!selectedRunId) { setDiff(null); return }
    let cancelled = false
    api.runs.diff(workflow.meta.id, selectedRunId)
      .then(d => { if (!cancelled) setDiff(d) })
      .catch(() => { if (!cancelled) setDiff(null) })
    return () => { cancelled = true }
  }, [selectedRunId, workflow.meta.id, selectedRun?.lastEventAt, selectedRun?.disposition, detailRefreshKey])

  useEffect(() => {
    dispatchResultAction({ type: 'reset' })
    if (selectedRunId) {
      const pending = pendingResultRuns.current.get(selectedRunId)
      if (pending) dispatchResultAction({ type: 'start', action: pending })
    }
  }, [selectedRunId])

  function selectRun(runId: string) {
    setSelectedRunId(prev => prev === runId ? prev : runId)
  }

  async function performResultAction(action: RunResultActionKind) {
    if (!selectedRun || pendingResultRuns.current.has(selectedRun.runId)) return
    const actionRunId = selectedRun.runId
    pendingResultRuns.current.set(actionRunId, action)
    dispatchResultAction({ type: 'start', action })
    try {
      if (action === 'apply') await api.runs.apply(workflow.meta.id, actionRunId)
      else await api.runs.discard(workflow.meta.id, actionRunId)
      if (selectedRunIdRef.current === actionRunId) dispatchResultAction({ type: 'succeed', action })
      await refresh()
      if (selectedRunIdRef.current === actionRunId) setDetailRefreshKey(key => key + 1)
    } catch (err) {
      await refresh()
      if (selectedRunIdRef.current === actionRunId) {
        setDetailRefreshKey(key => key + 1)
        dispatchResultAction({ type: 'fail', message: err instanceof Error ? err.message : `Could not ${action} this result.` })
      }
    } finally {
      pendingResultRuns.current.delete(actionRunId)
    }
  }

  function ResultActions() {
    if (!selectedRun?.managed) return null
    const disposition = resultAction.completed === 'apply'
      ? 'applied'
      : resultAction.completed === 'discard'
        ? 'discarded'
        : selectedRun.disposition
    if (disposition === 'unavailable' && !selectedRun.actionError) return null

    const resultSha = selectedRun.appliedSha ?? selectedRun.resultSha
    const terminal = disposition === 'applied' || disposition === 'discarded'
    const error = resultAction.error ?? selectedRun.actionError?.message ?? null
    return (
      <section className={`runs-mode__result runs-mode__result--${disposition}`} aria-labelledby="run-result-heading">
        <div className="runs-mode__result-copy">
          <div className="runs-mode__result-heading-row">
            <h4 id="run-result-heading" className="runs-mode__result-title">
              {disposition === 'applied'
                ? 'Result applied'
                : disposition === 'discarded'
                  ? 'Result discarded'
                  : disposition === 'applying'
                    ? 'Apply needs completion'
                    : disposition === 'discarding'
                      ? 'Discard needs completion'
                      : 'Result ready'}
            </h4>
            {resultSha && <code className="runs-mode__result-sha" title={resultSha}>{resultSha.slice(0, 12)}</code>}
          </div>
          <p className="runs-mode__result-description">
            {disposition === 'applied'
              ? 'The destination fast-forwarded to this result.'
              : disposition === 'discarded'
                ? 'The verified CWC result branch was deleted. The destination was not changed.'
                : disposition === 'applying' || disposition === 'discarding'
                  ? 'The previous request was interrupted. Retry it to reconcile the verified repository state.'
                : selectedRun.actions.apply
                  ? 'Apply fast-forwards the unchanged destination. Discard deletes only the verified result branch.'
                  : 'This failed run left a checkpointed branch. Review it below or discard that branch.'}
          </p>
        </div>

        {!terminal && !resultAction.confirmingDiscard && (
          <div className="runs-mode__result-actions">
            {selectedRun.actions.apply && (
              <button
                type="button"
                className="runs-mode__result-apply"
                onClick={() => void performResultAction('apply')}
                disabled={resultAction.pending !== null}
              >
                {resultAction.pending === 'apply' ? 'Applying result…' : disposition === 'applying' ? 'Retry Apply' : 'Apply result'}
              </button>
            )}
            {selectedRun.actions.discard && (
              <button
                type="button"
                className="runs-mode__result-discard"
                onClick={() => dispatchResultAction({ type: 'request_discard' })}
                disabled={resultAction.pending !== null}
              >
                {resultAction.pending === 'discard' ? 'Discarding result…' : disposition === 'discarding' ? 'Retry Discard' : 'Discard'}
              </button>
            )}
          </div>
        )}

        {!terminal && resultAction.confirmingDiscard && (
          <div className="runs-mode__discard-confirm" role="alertdialog" aria-labelledby="discard-result-title">
            <p id="discard-result-title">Delete the verified CWC result branch? This cannot be undone.</p>
            <div className="runs-mode__discard-confirm-actions">
              <button type="button" className="runs-mode__discard-cancel" onClick={() => dispatchResultAction({ type: 'cancel_discard' })}>
                Keep result
              </button>
              <button type="button" className="runs-mode__result-discard runs-mode__result-discard--confirm" onClick={() => void performResultAction('discard')}>
                Discard result
              </button>
            </div>
          </div>
        )}

        {error && !terminal && <p className="runs-mode__result-error" role="alert">{error}</p>}
      </section>
    )
  }

  // Timeline summary footer
  function TimelineSummary() {
    const total = timeline.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
    const done = timeline.findLast?.(e => e.type === 'run_completed')
    const paused = timeline.findLast?.(e => e.type === 'run_paused' || e.type === 'awaiting_approval')
    if (!done && !paused && total === 0) return null
    const outcome = done
      ? (STATUS_LABEL[done.status ?? ''] ?? done.status ?? 'finished')
      : paused ? 'waiting for approval' : 'running'
    return (
      <div className="runs-mode__timeline-summary">
        <span className="runs-mode__summary-outcome">{outcome}</span>
        {total > 0 && <span className="runs-mode__summary-cost">total ${total.toFixed(2)}</span>}
      </div>
    )
  }

  return (
    <div className="runs-mode">
      {/* LEFT COLUMN */}
      <div className="runs-mode__left">
        {/* Approvals */}
        {pausedRuns.length > 0 && (
          <section className="runs-mode__approvals">
            <h4 className="runs-mode__section-heading">
              Needs approval
              <span className="runs-mode__section-badge">{pausedRuns.length}</span>
            </h4>
            {pausedRuns.map(r => (
              <InboxItem key={r.runId} run={r} onChanged={refresh} />
            ))}
          </section>
        )}

        {/* History */}
        <section className="runs-mode__history">
          <h4 className="runs-mode__section-heading">History</h4>
          {runs.length === 0 ? (
            <p className="runs-mode__empty">
              No runs yet. Start one with Test run, or run the workflow from any terminal.
            </p>
          ) : (
            <ul className="runs-mode__run-list">
              {runs.map(r => (
                <li key={r.runId}>
                  <button
                    type="button"
                    className={`runs-mode__run-row${selectedRunId === r.runId ? ' runs-mode__run-row--selected' : ''}`}
                    onClick={() => selectRun(r.runId)}
                  >
                    <span className={`runs-mode__run-status runs-mode__run-status--${r.status}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <span className="runs-mode__run-when">{fmtRelative(r.startedAt)}</span>
                    <span className="runs-mode__run-meta">
                      {fmtDuration(r.durationMs)} · {r.source === 'test' ? 'test' : 'terminal'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* RIGHT COLUMN */}
      <div className="runs-mode__right">
        {/* Settings toggle */}
        <div className="runs-mode__right-toolbar">
          <button
            type="button"
            className="runs-mode__gear"
            onClick={() => setShowSettings(s => !s)}
            title="Notification settings"
            aria-label="Notification settings"
            aria-expanded={showSettings}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7.2 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 20 7.2l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.8.8Z" />
            </svg>
          </button>
          {activeRun && (
            <button
              type="button"
              className="runs-mode__stop"
              onClick={() => api.runs.stop(activeRun.runId)}
            >
              Stop
            </button>
          )}
        </div>

        {showSettings && (
          <div className="runs-mode__settings-wrap">
            <SettingsBlock />
          </div>
        )}

        {/* Detail pane */}
        {runs.length === 0 && !activeRun ? (
          <div className="runs-mode__detail-empty">
            <p>No runs yet.</p>
            <p className="runs-mode__detail-empty-hint">
              Start one with Test run above, or run the workflow from any terminal.
            </p>
          </div>
        ) : timeline.length === 0 && !selectedRun ? (
          <div className="runs-mode__detail-empty">
            <p>Select a run on the left to see its timeline.</p>
          </div>
        ) : (
          <div className="runs-mode__detail">
            {selectedRun && (
              <div className="runs-mode__detail-header">
                <span className={`runs-mode__run-status runs-mode__run-status--${selectedRun.status}`}>
                  {STATUS_LABEL[selectedRun.status] ?? selectedRun.status}
                </span>
                <span className="runs-mode__detail-started">
                  {new Date(selectedRun.startedAt).toLocaleString()}
                </span>
                <span className="runs-mode__detail-meta">
                  {fmtDuration(selectedRun.durationMs)} · {selectedRun.source === 'test' ? 'test' : 'terminal'}
                </span>
              </div>
            )}

            {/* Paused approval inline in detail — surface it if this run needs approval */}
            {selectedRun?.status === 'paused' && (
              <div className="runs-mode__detail-approval">
                <p className="runs-mode__detail-approval-label">This run is paused and needs your approval:</p>
                <InboxItem key={selectedRun.runId} run={selectedRun} onChanged={refresh} />
              </div>
            )}

            {timeline.length > 0 ? (
              <>
                <ol className="runs-mode__timeline">
                  {timeline.map((e, i) => (
                    <li key={i} className={`runs-mode__event runs-mode__event--${e.type}`}>
                      <span className="runs-mode__event-type">{eventLabel(e.type)}</span>
                      {e.agentSlug && <span className="runs-mode__event-agent">{e.agentSlug}</span>}
                      {e.message && <span className="runs-mode__event-msg">{e.message}</span>}
                      {e.costUsd !== undefined && <span className="runs-mode__event-cost">${e.costUsd.toFixed(2)}</span>}
                    </li>
                  ))}
                </ol>
                <TimelineSummary />
                <ResultActions />
                {diff?.diff && (
                  <div className="runs-mode__diff">
                    <div className="runs-mode__diff-head">
                      <span className="runs-mode__diff-title">Changes</span>
                      {diff.branch && <span className="runs-mode__diff-branch">{diff.branch}</span>}
                    </div>
                    <div className="runs-mode__diff-body">
                      {diff.diff.split('\n').map((line, i) => (
                        <span key={i} className={`runs-mode__diff-line runs-mode__diff-line--${diffLineKind(line)}`}>{line || ' '}</span>
                      ))}
                    </div>
                    {diff.status && <pre className="runs-mode__diff-stat">{diff.status}</pre>}
                  </div>
                )}
                {diff?.error && selectedRun?.disposition === 'ready' && resultAction.completed === null && (
                  <p className="runs-mode__diff-error" role="status">Changes could not be refreshed: {diff.error}</p>
                )}
              </>
            ) : (
              <div className="runs-mode__timeline-loading">
                {isLiveView ? 'Waiting for events…' : 'Loading timeline…'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
