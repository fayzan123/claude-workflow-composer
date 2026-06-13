import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RunSummary } from '../../../../src/server/run-store.ts'
import { api } from '../../lib/api.ts'
import './RecentActivity.css'

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const STATUS_LABEL: Record<string, string> = {
  running: '● running',
  stale: '◌ stale',
  complete: '✓ done',
  escalated: '⚠ escalated',
  aborted: '■ aborted',
  error: '✕ error',
  paused: '⏸ paused',
}

export function RecentActivity() {
  const [recent, setRecent] = useState<RunSummary[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    api.runs.recent(20).then(setRecent).catch(() => setRecent([]))
  }, [])

  if (recent.length === 0) return null

  return (
    <div className="recent-activity">
      <h2 className="recent-activity__heading">Recent runs</h2>
      <ul className="recent-activity__list">
        {recent.map((run) => (
          <li key={run.runId} className="recent-activity__item">
            <button
              className="recent-activity__row"
              type="button"
              onClick={() => navigate(`/w/${run.workflowId}/runs`)}
            >
              <span className="recent-activity__slug">{run.workflowSlug}</span>
              <span className={`recent-activity__status recent-activity__status--${run.status}`}>
                {STATUS_LABEL[run.status] ?? run.status}
              </span>
              <span className="recent-activity__when">{relativeTime(run.startedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
