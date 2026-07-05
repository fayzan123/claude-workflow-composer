import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import { FieldHint } from './common/FieldHint.tsx'
import './RunModal.css'

interface Props {
  workflowId: string
  workflowSlug: string
  onStarted: (runId: string) => void
  onClose: () => void
  onExport?: () => void
}

const RECENT_CWDS_KEY = 'cwc-run-cwds'

function loadRecentCwds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_CWDS_KEY) ?? '[]') } catch { return [] }
}

function saveRecentCwd(cwd: string) {
  const next = [cwd, ...loadRecentCwds().filter(c => c !== cwd)].slice(0, 5)
  localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(next))
}

export function RunModal({ workflowId, workflowSlug, onStarted, onClose, onExport }: Props) {
  const recents = loadRecentCwds()
  const [cwd, setCwd] = useState(recents[0] ?? '')
  const [isolation, setIsolation] = useState<'worktree' | 'in-place'>('worktree')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // null = still checking, true/false = whether the user-scoped export list contains this slug.
  // Project-scoped skills are resolved by the server against the chosen cwd.
  const [exported, setExported] = useState<boolean | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pre-flight: check the user-scoped deployed list. This cannot see project-scoped
  // exports, so it warns only; the server validates user/project skill paths on start.
  useEffect(() => {
    let cancelled = false
    api.exportedWorkflows.list()
      .then(list => { if (!cancelled) setExported(list.some(w => w.slug === workflowSlug)) })
      .catch(() => { if (!cancelled) setExported(true) }) // network failure: don't block, let server validate
    return () => { cancelled = true }
  }, [workflowSlug])

  async function start() {
    setError(null)
    setStarting(true)
    try {
      const { runId } = await api.runs.start(workflowId, workflowSlug, cwd.trim(), isolation)
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
          Runs <code>/{workflowSlug}</code> headlessly with your local Claude Code.
        </p>
        {exported === false && (
          <div className="run-modal__not-exported">
            <strong>No user-scoped export found.</strong>
            <p>
              CWC will still check for <code>/{workflowSlug}</code> under the selected
              project's <code>.claude/skills</code> directory when the run starts.
              If neither location has it, the server will stop the run before launching Claude.
            </p>
            {onExport && (
              <button
                type="button"
                className="run-modal__export-cta"
                onClick={() => { onClose(); onExport() }}
              >
                Export workflow…
              </button>
            )}
          </div>
        )}
        <label className="run-modal__label">
          Working directory
          <FieldHint id="run.cwd" />
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
        <label className="run-modal__label">
          Isolation
          <FieldHint id="run.isolation" />
          <select value={isolation} onChange={e => setIsolation(e.target.value as 'worktree' | 'in-place')} className="run-modal__select">
            <option value="worktree">Worktree (isolated branch)</option>
            <option value="in-place">In-place (current checkout)</option>
          </select>
        </label>
        <p className="run-modal__consent">
          Caution: the run executes with <strong>bypassPermissions</strong>, so agents may
          create/modify files and run commands (git, tests, etc.) in this directory without asking.
          Use worktree isolation to keep your checkout untouched.
        </p>
        {error && <p className="run-modal__error">{error}</p>}
        <div className="run-modal__actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="run-modal__start"
            disabled={!cwd.trim() || starting}
            onClick={start}
          >
            {starting ? 'Starting...' : 'Start run'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
