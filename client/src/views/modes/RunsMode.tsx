import React, { useState, useEffect } from 'react'
import type { RunEvent } from '../../../../src/run-events.ts'
import type { RunSummary } from '../../../../src/server/run-store.ts'
import { api } from '../../lib/api.ts'
import { InboxItem } from '../../components/runs/InboxItem.tsx'
import { SettingsBlock } from '../../components/runs/SettingsBlock.tsx'
import { fmtDuration, fmtRelative, STATUS_LABEL, eventLabel } from '../../components/runs/format.ts'
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
  const [diff, setDiff] = useState<{ diff: string | null; status: string | null; branch: string | null } | null>(null)

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
  }, [selectedRunId, activeRun?.runId, workflow.meta.id])

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
  }, [selectedRunId, workflow.meta.id, selectedRun?.lastEventAt])

  function selectRun(runId: string) {
    setSelectedRunId(prev => prev === runId ? prev : runId)
  }

  // Timeline summary footer
  function TimelineSummary() {
    const total = timeline.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
    const done = timeline.findLast?.(e => e.type === 'run_completed')
    const paused = timeline.findLast?.(e => e.type === 'run_paused' || e.type === 'awaiting_approval')
    if (!done && !paused && total === 0) return null
    const outcome = done
      ? (STATUS_LABEL[done.status ?? ''] ?? done.status ?? 'finished')
      : paused ? '⏸ waiting for approval' : '● running'
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
              No runs yet. Start one with ▶ Test Run, or run the workflow from any terminal.
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
            ⚙
          </button>
          {activeRun && (
            <button
              type="button"
              className="runs-mode__stop"
              onClick={() => api.runs.stop(activeRun.runId)}
            >
              ■ Stop
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
              Start one with ▶ Test Run above, or run the workflow from any terminal.
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
                {diff?.diff && (
                  <div className="runs-mode__diff">
                    <div className="runs-mode__diff-head">
                      <span className="runs-mode__diff-title">Changes</span>
                      {diff.branch && <span className="runs-mode__diff-branch">{diff.branch}</span>}
                    </div>
                    <pre className="runs-mode__diff-body">{diff.diff}</pre>
                    {diff.status && <pre className="runs-mode__diff-stat">{diff.status}</pre>}
                  </div>
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
