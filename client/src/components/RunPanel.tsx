import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { RunEvent } from '../../../src/run-events.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'
import { api } from '../lib/api.ts'
import './RunPanel.css'

interface Props {
  workflowId: string
  runs: RunSummary[]
  liveEvents: RunEvent[]
  activeRun: RunSummary | null
  pausedRuns: RunSummary[]
  onClose: () => void
  onChanged: () => void
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

const STATUS_LABEL: Record<string, string> = {
  running: '● running', stale: '◌ stale', complete: '✓ complete',
  escalated: '⚠ escalated', aborted: '■ aborted', error: '✕ error',
  paused: '⏸ paused',
}

// Plain-English labels for the run timeline. Raw event types like "step_started"
// leak the data model at people who just want to know what the run is doing.
const EVENT_LABEL: Record<string, string> = {
  run_started: 'Run started',
  step_started: 'Started',
  step_completed: 'Finished',
  artifact_produced: 'Produced file',
  awaiting_approval: 'Waiting for your approval',
  run_paused: 'Paused for approval',
  run_completed: 'Run finished',
}

function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, ' ')
}

// ----- InboxItem -----

interface InboxItemProps {
  run: RunSummary
  onChanged: () => void
}

function InboxItem({ run, onChanged }: InboxItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents] = useState<RunEvent[] | null>(null)
  const [diffResult, setDiffResult] = useState<{ diff: string | null; status: string | null; branch: string | null } | null>(null)
  const [note, setNote] = useState('')
  const [actError, setActError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)

  function expand() {
    setExpanded(e => !e)
  }

  // Refetch events + diff whenever the card is open AND whenever the run gets a
  // new event (lastEventAt changes). A one-shot fetch on expand races the
  // run_paused event — if the card opens between awaiting_approval and run_paused,
  // it would cache "no resumable session" forever and wrongly disable Approve.
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    void Promise.all([
      api.runs.events(run.workflowId, run.runId).catch(() => [] as RunEvent[]),
      api.runs.diff(run.workflowId, run.runId).catch(() => ({ diff: null, status: null, branch: null })),
    ]).then(([evs, diff]) => {
      if (cancelled) return
      setEvents(evs)
      setDiffResult(diff)
    })
    return () => { cancelled = true }
  }, [expanded, run.workflowId, run.runId, run.lastEventAt])

  const hasPausedEvent = events?.some(e => e.type === 'run_paused') ?? false
  const approvalMsg = events?.findLast?.(e => e.type === 'awaiting_approval' || e.type === 'run_paused')?.message

  // On success we deliberately leave `acting` true: the card stays disabled (showing
  // "Approving…") until the run leaves the paused list and this item unmounts. Only
  // re-enable on error so the user can retry. This stops the "it wasn't instant so I
  // kept clicking" double-fire.
  async function doApprove() {
    setActError(null)
    setActing(true)
    try {
      await api.runs.approve(run.workflowId, run.runId, note || undefined)
      onChanged()
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Failed to approve')
      setActing(false)
    }
  }

  async function doReject() {
    setActError(null)
    setActing(true)
    try {
      await api.runs.reject(run.workflowId, run.runId, note || undefined)
      onChanged()
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Failed to reject')
      setActing(false)
    }
  }

  const approveDisabled = !hasPausedEvent && events !== null
  const approveTooltip = approveDisabled
    ? "This run was started from a terminal, so CWC can't resume it here — continue it where you launched it, or reject to clean up."
    : undefined

  return (
    <div className="run-panel__inbox-item">
      <button type="button" className="run-panel__inbox-header" onClick={expand}>
        <span className="run-panel__inbox-slug">{run.workflowSlug ?? run.workflowId}</span>
        <span className="run-panel__inbox-when">{fmtRelative(run.lastEventAt ?? run.startedAt)}</span>
        {diffResult?.branch && <span className="run-panel__inbox-branch">{diffResult.branch}</span>}
        <span className="run-panel__inbox-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="run-panel__inbox-body">
          {approvalMsg && (
            <p className="run-panel__inbox-msg">{approvalMsg}</p>
          )}

          {diffResult === null ? (
            <p className="run-panel__inbox-loading">Loading diff…</p>
          ) : diffResult.diff === null ? (
            <p className="run-panel__inbox-no-git">No git repo here, so there's no diff to preview — review the agent's work directly, then approve or reject below.</p>
          ) : (
            <>
              <pre className="run-panel__diff">{diffResult.diff}</pre>
              {diffResult.status && (
                <div className="run-panel__diff-status">
                  <strong>Status:</strong>
                  <pre className="run-panel__diff">{diffResult.status}</pre>
                </div>
              )}
            </>
          )}

          <textarea
            className="run-panel__inbox-note"
            placeholder="Optional note for the agent…"
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
          />

          {actError && <p className="run-panel__inbox-error">{actError}</p>}
          {approveDisabled && (
            <p className="run-panel__inbox-hint">{approveTooltip}</p>
          )}

          <div className="run-panel__inbox-actions">
            <button
              type="button"
              className="run-panel__inbox-approve"
              onClick={doApprove}
              disabled={acting || approveDisabled}
              title={approveTooltip}
            >
              {acting ? 'Approving…' : '✓ Approve'}
            </button>
            <button
              type="button"
              className="run-panel__inbox-reject"
              onClick={doReject}
              disabled={acting}
            >
              {acting ? 'Rejecting…' : '✕ Reject'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ----- SettingsBlock -----

function SettingsBlock() {
  const [config, setConfig] = useState<{ notifications: { macos: boolean; webhookUrl?: string } } | null>(null)
  const [webhookInput, setWebhookInput] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.automations.config().then(c => {
      setConfig(c)
      setWebhookInput(c.notifications.webhookUrl ?? '')
    }).catch(() => {})
  }, [])

  async function toggle(key: 'macos') {
    if (!config) return
    const next = { ...config, notifications: { ...config.notifications, [key]: !config.notifications[key] } }
    setConfig(next)
    setSaving(true)
    await api.automations.setConfig(next).catch(() => {})
    setSaving(false)
  }

  async function saveWebhook() {
    if (!config) return
    const next = { ...config, notifications: { ...config.notifications, webhookUrl: webhookInput || undefined } }
    setConfig(next)
    setSaving(true)
    await api.automations.setConfig(next).catch(() => {})
    setSaving(false)
  }

  if (!config) return <div className="run-panel__settings-loading">Loading…</div>

  return (
    <div className="run-panel__settings">
      <label className="run-panel__settings-row">
        <span>macOS notifications</span>
        <input type="checkbox" checked={config.notifications.macos} onChange={() => toggle('macos')} />
      </label>
      <label className="run-panel__settings-row">
        <span>Webhook URL</span>
      </label>
      <div className="run-panel__settings-webhook">
        <input
          type="url"
          placeholder="https://hooks.slack.com/…"
          value={webhookInput}
          onChange={e => setWebhookInput(e.target.value)}
          className="run-panel__settings-input"
        />
        <button type="button" onClick={saveWebhook} disabled={saving} className="run-panel__settings-save">
          {saving ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ----- PauseToggle -----

function PauseToggle() {
  const [paused, setPaused] = useState<boolean | null>(null)

  useEffect(() => {
    api.automations.state().then(s => setPaused(s.paused)).catch(() => {})
  }, [])

  async function toggle() {
    if (paused === null) return
    const next = !paused
    setPaused(next)
    await api.automations.setPaused(next).catch(() => setPaused(paused))
  }

  return (
    <label className="run-panel__pause-toggle" title={paused === null ? 'Loading…' : paused ? 'Automations paused — click to resume' : 'Automations running — click to pause'}>
      <span className="run-panel__pause-label">Automations</span>
      <button
        type="button"
        role="switch"
        aria-checked={paused === false}
        className={`run-panel__toggle-btn ${paused === false ? 'run-panel__toggle-btn--on' : ''}`}
        onClick={toggle}
        disabled={paused === null}
      >
        {paused === null ? '…' : paused ? 'Paused' : 'On'}
      </button>
    </label>
  )
}

// ----- RunPanel -----

export function RunPanel({ workflowId, runs, liveEvents, activeRun, pausedRuns, onClose, onChanged }: Props) {
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [replayEvents, setReplayEvents] = useState<RunEvent[]>([])
  const [showSettings, setShowSettings] = useState(false)

  async function openRun(runId: string) {
    if (openRunId === runId) { setOpenRunId(null); return }
    setReplayEvents(await api.runs.events(workflowId, runId).catch(() => []))
    setOpenRunId(runId)
  }

  const showLive = activeRun !== null && liveEvents.length > 0
  const timeline = showLive && openRunId === null ? liveEvents : replayEvents

  return (
    <aside className="run-panel">
      <header className="run-panel__header">
        <h3>Runs</h3>
        <PauseToggle />
        <button type="button" className="run-panel__gear" onClick={() => setShowSettings(s => !s)} title="Notification settings" aria-label="Settings">
          ⚙
        </button>
        {activeRun && (
          <button type="button" className="run-panel__stop" onClick={() => api.runs.stop(activeRun.runId)}>
            ■ Stop
          </button>
        )}
        <button type="button" className="run-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      {showSettings && <SettingsBlock />}

      {pausedRuns.length > 0 && (
        <section className="run-panel__inbox">
          <h4>Needs approval ({pausedRuns.length})</h4>
          {pausedRuns.map(r => (
            <InboxItem key={r.runId} run={r} onChanged={onChanged} />
          ))}
        </section>
      )}

      <ul className="run-panel__list">
        {runs.length === 0 && <li className="run-panel__empty">No runs yet. Export the workflow, then run it here or from any terminal.</li>}
        {runs.map(r => (
          <li key={r.runId}>
            <button type="button" className={`run-panel__run ${openRunId === r.runId ? 'run-panel__run--open' : ''}`} onClick={() => openRun(r.runId)}>
              <span className={`run-panel__status run-panel__status--${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
              <span className="run-panel__when">{new Date(r.startedAt).toLocaleString()}</span>
              <span className="run-panel__meta">{fmtDuration(r.durationMs)} · {r.source === 'test' ? 'test' : 'terminal'}</span>
            </button>
          </li>
        ))}
      </ul>

      {(showLive || openRunId) && (
        <>
          <ol className="run-panel__timeline">
            {timeline.map((e, i) => (
              <li key={i} className={`run-panel__event run-panel__event--${e.type}`}>
                <span className="run-panel__event-type">{eventLabel(e.type)}</span>
                {e.agentSlug && <span className="run-panel__event-agent">{e.agentSlug}</span>}
                {e.message && <span className="run-panel__event-msg">{e.message}</span>}
                {e.costUsd !== undefined && <span className="run-panel__event-cost">${e.costUsd.toFixed(2)}</span>}
              </li>
            ))}
          </ol>
          {(() => {
            const total = timeline.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)
            const done = timeline.findLast?.(e => e.type === 'run_completed')
            const paused = timeline.findLast?.(e => e.type === 'run_paused' || e.type === 'awaiting_approval')
            if (!done && !paused && total === 0) return null
            const outcome = done
              ? (STATUS_LABEL[done.status ?? ''] ?? done.status ?? 'finished')
              : paused ? '⏸ waiting for approval' : '● running'
            return (
              <div className="run-panel__timeline-summary">
                <span className="run-panel__summary-outcome">{outcome}</span>
                {total > 0 && <span className="run-panel__summary-cost">total ${total.toFixed(2)}</span>}
              </div>
            )
          })()}
        </>
      )}
    </aside>
  )
}
