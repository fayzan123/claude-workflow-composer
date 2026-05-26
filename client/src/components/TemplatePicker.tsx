import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { CwcFile } from '../types.ts'
import './TemplatePicker.css'

interface Props {
  onSelect: (cwc: CwcFile, path: string) => void
  onOpenRecent: (path: string) => void
}

type Tab = 'new' | 'recent'

function formatPath(path: string): { name: string; dir: string } {
  const parts = path.replace(/\.cwc$/, '').split('/')
  const name = parts[parts.length - 1]
  const dir = path.replace(/^\/Users\/[^/]+/, '~').replace(/\/[^/]*\.cwc$/, '')
  return { name: name || 'Untitled', dir }
}

export function TemplatePicker({ onSelect, onOpenRecent }: Props) {
  const [recents, setRecents] = useState<string[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('new')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.claudeCheck().then((r) => { if (!r.installed) setNotInstalled(true) }).catch(() => {})
    api.recents.list().then(setRecents).catch(() => {})
  }, [])

  async function handleDelete(path: string) {
    try {
      await api.workflows.delete(path)
      await api.recents.remove(path)
      setRecents((r) => r.filter((p) => p !== path))
    } catch {
      setRecents((r) => r.filter((p) => p !== path))
    }
  }

  async function handleNewWorkflow() {
    setError(null)
    setCreating(true)
    try {
      const cwc: CwcFile = {
        meta: {
          id: crypto.randomUUID(),
          name: 'Untitled Workflow',
          description: '',
          version: 1,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        },
        nodes: [],
        edges: [],
      }
      const pathRes = await fetch(`/api/workflows/default-path?name=${encodeURIComponent(cwc.meta.name)}`)
      const { path: resolvedPath } = await pathRes.json() as { path: string }
      await api.workflows.save(resolvedPath, cwc)
      await api.recents.add(resolvedPath)
      onSelect(cwc, resolvedPath)
    } catch {
      setError('Failed to create workflow. Is the server running?')
      setCreating(false)
    }
  }

  if (notInstalled) {
    return (
      <div className="template-picker">
        <div className="template-picker__notice">
          <div className="template-picker__notice-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>
          <h2 className="template-picker__notice-title">Claude Code not found</h2>
          <p className="template-picker__notice-desc">
            Install Claude Code first, then relaunch <code>npx cwc</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="template-picker">
      <header className="template-picker__header">
        <div className="template-picker__logo">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <h1 className="template-picker__title">Workflow Composer</h1>
        <p className="template-picker__subtitle">
          Visually compose multi-agent workflows for Claude Code.
          Drag agents, attach skills, wire handoffs, and export.
        </p>
      </header>

      <div className="template-picker__tabs">
        <button
          className={`template-picker__tab${activeTab === 'new' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('new')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          New Workflow
        </button>
        <button
          className={`template-picker__tab${activeTab === 'recent' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('recent')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Recent
          {recents.length > 0 && <span className="template-picker__tab-badge">{recents.length}</span>}
        </button>
      </div>

      {error && (
        <div className="template-picker__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
          </svg>
          {error}
        </div>
      )}

      {activeTab === 'new' && (
        <section className="template-picker__section">
          <button
            className="template-card template-card--blank"
            onClick={handleNewWorkflow}
            disabled={creating}
            type="button"
          >
            <div className="template-card__icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
            </div>
            <span className="template-card__title">Blank Canvas</span>
            <span className="template-card__desc">Start from scratch with your own agents and skills</span>
          </button>
        </section>
      )}

      {activeTab === 'recent' && (
        <section className="template-picker__section">
          {recents.length === 0 ? (
            <div className="template-picker__empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <p className="template-picker__empty-text">No recent workflows yet.</p>
              <p className="template-picker__empty-hint">Create a new workflow to get started.</p>
            </div>
          ) : (
            <div className="template-picker__recent-list">
              {recents.map((path) => {
                const { name, dir } = formatPath(path)
                return (
                  <div key={path} className="template-picker__recent-item">
                    <button
                      className="template-picker__recent-link"
                      onClick={() => onOpenRecent(path)}
                      type="button"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="template-picker__recent-name">{name}</span>
                      <span className="template-picker__recent-dir">{dir}</span>
                    </button>
                    <button
                      className="template-picker__recent-delete"
                      onClick={() => handleDelete(path)}
                      aria-label="Delete workflow"
                      type="button"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
