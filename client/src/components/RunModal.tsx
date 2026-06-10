import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import './RunModal.css'

interface Props {
  workflowId: string
  workflowSlug: string
  onStarted: (runId: string) => void
  onClose: () => void
}

const RECENT_CWDS_KEY = 'cwc-run-cwds'

function loadRecentCwds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_CWDS_KEY) ?? '[]') } catch { return [] }
}

function saveRecentCwd(cwd: string) {
  const next = [cwd, ...loadRecentCwds().filter(c => c !== cwd)].slice(0, 5)
  localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(next))
}

export function RunModal({ workflowId, workflowSlug, onStarted, onClose }: Props) {
  const recents = loadRecentCwds()
  const [cwd, setCwd] = useState(recents[0] ?? '')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function start() {
    setError(null)
    setStarting(true)
    try {
      const { runId } = await api.runs.start(workflowId, workflowSlug, cwd.trim())
      saveRecentCwd(cwd.trim())
      onStarted(runId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run')
      setStarting(false)
    }
  }

  return createPortal(
    <div className="run-modal__backdrop" onClick={onClose}>
      <div className="run-modal" onClick={e => e.stopPropagation()}>
        <h2>Test Run</h2>
        <p className="run-modal__hint">
          Runs <code>/{workflowSlug}</code> headlessly with your local Claude Code. The workflow must be exported first.
        </p>
        <label className="run-modal__label">
          Working directory
          <input
            value={cwd}
            onChange={e => setCwd(e.target.value)}
            placeholder="/absolute/path/to/project"
            autoFocus
          />
        </label>
        {recents.length > 0 && (
          <div className="run-modal__recents">
            {recents.map(r => (
              <button key={r} type="button" className="run-modal__recent" onClick={() => setCwd(r)}>{r}</button>
            ))}
          </div>
        )}
        <p className="run-modal__consent">
          ⚠ The run executes with <strong>acceptEdits</strong>: agents may create and modify files in this
          directory without asking. Other permissions still follow your Claude Code settings.
        </p>
        {error && <p className="run-modal__error">{error}</p>}
        <div className="run-modal__actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="run-modal__start" disabled={!cwd.trim() || starting} onClick={start}>
            {starting ? 'Starting…' : '▶ Start run'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
