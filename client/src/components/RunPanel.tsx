import React, { useState } from 'react'
import type { RunEvent } from '../../../src/run-events.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'
import { api } from '../lib/api.ts'
import './RunPanel.css'

interface Props {
  workflowId: string
  runs: RunSummary[]
  liveEvents: RunEvent[]
  activeRun: RunSummary | null
  onClose: () => void
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

const STATUS_LABEL: Record<string, string> = {
  running: '● running', stale: '◌ stale', complete: '✓ complete',
  escalated: '⚠ escalated', aborted: '■ aborted', error: '✕ error',
}

export function RunPanel({ workflowId, runs, liveEvents, activeRun, onClose }: Props) {
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [replayEvents, setReplayEvents] = useState<RunEvent[]>([])

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
        {activeRun && (
          <button type="button" className="run-panel__stop" onClick={() => api.runs.stop(activeRun.runId)}>
            ■ Stop
          </button>
        )}
        <button type="button" className="run-panel__close" onClick={onClose} aria-label="Close">×</button>
      </header>

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
        <ol className="run-panel__timeline">
          {timeline.map((e, i) => (
            <li key={i} className={`run-panel__event run-panel__event--${e.type}`}>
              <span className="run-panel__event-type">{e.type.replace('_', ' ')}</span>
              {e.agentSlug && <span className="run-panel__event-agent">{e.agentSlug}</span>}
              {e.message && <span className="run-panel__event-msg">{e.message}</span>}
              {e.costUsd !== undefined && <span className="run-panel__event-cost">${e.costUsd.toFixed(2)}</span>}
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
