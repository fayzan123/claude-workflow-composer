import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RunSummary } from '../../../../src/server/run-store.ts'
import { api } from '../../lib/api.ts'
import './NeedsYou.css'

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function NeedsYou() {
  const [paused, setPaused] = useState<RunSummary[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    api.runs.paused().then(setPaused).catch(() => setPaused([]))
  }, [])

  if (paused.length === 0) return null

  return (
    <div className="needs-you">
      <h2 className="needs-you__heading">Needs your approval</h2>
      <ul className="needs-you__list">
        {paused.map((run) => (
          <li key={run.runId} className="needs-you__item">
            <button
              className="needs-you__row"
              type="button"
              onClick={() => navigate(`/w/${run.workflowId}/runs`)}
            >
              <span className="needs-you__slug">{run.workflowSlug ?? run.workflowId}</span>
              <span className="needs-you__when">{relativeTime(run.startedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
