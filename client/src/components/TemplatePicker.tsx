import { useEffect, useState, useRef } from 'react'
import { api } from '../lib/api.ts'
import type { CwcFile } from '../types.ts'
import type { ExportedWorkflowEntry } from '../../../src/server/api/exported-workflows.ts'
import { TEMPLATES } from '../templates/index.ts'
import './TemplatePicker.css'

type WorkflowListItem = { path: string; name: string; nodeCount: number; updated: string }

interface Props {
  onSelect: (cwc: CwcFile, path: string) => void
  onOpenRecent: (path: string) => Promise<void>
}

type Tab = 'new' | 'workflows' | 'deployed'

export function relativeTime(isoString: string, now = Date.now()): string {
  const diff = now - new Date(isoString).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const days = Math.floor(hr / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

export function TemplatePicker({ onSelect, onOpenRecent }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [deployed, setDeployed] = useState<ExportedWorkflowEntry[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('new')
  const [creating, setCreating] = useState(false)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.claudeCheck().then((r) => { if (!r.installed) setNotInstalled(true) }).catch(() => {})
    api.workflows.list().then((items) => {
      setWorkflows(items.slice().sort((a, b) => b.updated.localeCompare(a.updated)))
    }).catch(() => {})
    api.exportedWorkflows.list().then(setDeployed).catch(() => {})
  }, [])

  useEffect(() => {
    if (!deletingPath) return
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setDeletingPath(null) }
    function handleClick(e: MouseEvent) {
      if (!confirmRef.current?.contains(e.target as Node)) setDeletingPath(null)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [deletingPath])

  async function handleDelete(path: string) {
    try {
      let cwcFile: CwcFile | undefined
      try { cwcFile = await api.workflows.read(path) } catch { /* corrupted or missing */ }
      if (cwcFile) {
        try { await api.deleteExport(cwcFile, { type: 'user' }) } catch { /* best-effort */ }
      }
      await api.workflows.delete(path)
      await api.recents.remove(path)
      setWorkflows((ws) => ws.filter((w) => w.path !== path))
    } catch {
      setWorkflows((ws) => ws.filter((w) => w.path !== path))
    } finally {
      setDeletingPath(null)
    }
  }

  async function handleDeleteDeployed(slug: string) {
    try {
      await api.exportedWorkflows.delete(slug)
    } catch { /* best-effort */ } finally {
      setDeployed((ds) => ds.filter((d) => d.slug !== slug))
      setDeletingSlug(null)
    }
  }

  async function createAndOpen(cwc: CwcFile) {
    setError(null)
    setCreating(true)
    try {
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

  function handleNewWorkflow() {
    createAndOpen({
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
    })
  }

  function handleTemplateSelect(templateId: string) {
    const tmpl = TEMPLATES.find(t => t.id === templateId)
    if (tmpl) createAndOpen(tmpl.build())
  }

  if (notInstalled) {
    return (
      <div className="template-picker">
        <div className="template-picker__notice">
          <div className="template-picker__notice-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
            </svg>
          </div>
          <h2 className="template-picker__notice-title">Claude Code not found</h2>
          <p className="template-picker__notice-desc">Install Claude Code first, then relaunch <code>npx cwc</code>.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="template-picker">
      <header className="template-picker__header">
        <div className="template-picker__logo">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
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
          className={`template-picker__tab${activeTab === 'workflows' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('workflows')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          Workflows
          {workflows.length > 0 && <span className="template-picker__tab-badge">{workflows.length}</span>}
        </button>
        <button
          className={`template-picker__tab${activeTab === 'deployed' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('deployed')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          Deployed
          {deployed.length > 0 && <span className="template-picker__tab-badge">{deployed.length}</span>}
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
          <div className="template-picker__templates-heading">Starter Templates</div>
          <div className="template-picker__templates-grid">
            {TEMPLATES.map(tmpl => (
              <button
                key={tmpl.id}
                className="template-card template-card--starter"
                onClick={() => handleTemplateSelect(tmpl.id)}
                disabled={creating}
                type="button"
              >
                <div className="template-card__meta">
                  <span className="template-card__node-count">{tmpl.nodeCount} agents</span>
                  <div className="template-card__tags">
                    {tmpl.tags.map(tag => (
                      <span key={tag} className="template-card__tag">{tag}</span>
                    ))}
                  </div>
                </div>
                <span className="template-card__title">{tmpl.name}</span>
                <span className="template-card__desc">{tmpl.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeTab === 'deployed' && (
        <section className="template-picker__section">
          {deployed.length === 0 ? (
            <div className="template-picker__empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <p className="template-picker__empty-text">No deployed workflows.</p>
              <p className="template-picker__empty-hint">Export a workflow to see it here.</p>
            </div>
          ) : (
            <div className="template-picker__recent-list">
              {deployed.map((item) => {
                const isConfirming = deletingSlug === item.slug
                return (
                  <div key={item.slug} className={`template-picker__recent-item${isConfirming ? ' template-picker__recent-item--confirming' : ''}`}>
                    <div className="template-picker__recent-link template-picker__recent-link--static">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                      </svg>
                      <div className="template-picker__recent-info">
                        <span className="template-picker__recent-name">{item.name}</span>
                        {item.description && (
                          <span className="template-picker__recent-meta">{item.description}</span>
                        )}
                        <span className="template-picker__recent-dir">~/.claude/skills/{item.slug}</span>
                      </div>
                    </div>
                    {isConfirming ? (
                      <div ref={confirmRef} className="template-picker__confirm-delete">
                        <span className="template-picker__confirm-msg">Remove from Claude?</span>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--yes"
                          onClick={() => handleDeleteDeployed(item.slug)}
                          type="button"
                        >
                          Remove
                        </button>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--no"
                          onClick={() => setDeletingSlug(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="template-picker__recent-delete"
                        onClick={() => setDeletingSlug(item.slug)}
                        aria-label="Remove deployed workflow"
                        type="button"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === 'workflows' && (
        <section className="template-picker__section">
          {workflows.length === 0 ? (
            <div className="template-picker__empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <p className="template-picker__empty-text">No workflows yet.</p>
              <p className="template-picker__empty-hint">Create a new workflow to get started.</p>
            </div>
          ) : (
            <div className="template-picker__recent-list">
              {workflows.map((item) => {
                const dir = shortenPath(item.path).replace(/\/[^/]*\.cwc$/, '')
                const isConfirming = deletingPath === item.path
                return (
                  <div key={item.path} className={`template-picker__recent-item${isConfirming ? ' template-picker__recent-item--confirming' : ''}`}>
                    <button
                      className="template-picker__recent-link"
                      onClick={() => {
                        onOpenRecent(item.path).catch(() => {
                          setWorkflows((ws) => ws.filter((w) => w.path !== item.path))
                          setError('That workflow was deleted or moved.')
                        })
                      }}
                      type="button"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <div className="template-picker__recent-info">
                        <span className="template-picker__recent-name">{item.name}</span>
                        <span className="template-picker__recent-meta">
                          {item.nodeCount} agent{item.nodeCount !== 1 ? 's' : ''} · {relativeTime(item.updated)}
                        </span>
                        <span className="template-picker__recent-dir">{dir}</span>
                      </div>
                    </button>
                    {isConfirming ? (
                      <div ref={confirmRef} className="template-picker__confirm-delete">
                        <span className="template-picker__confirm-msg">Delete?</span>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--yes"
                          onClick={() => handleDelete(item.path)}
                          type="button"
                        >
                          Delete
                        </button>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--no"
                          onClick={() => setDeletingPath(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="template-picker__recent-delete"
                        onClick={() => setDeletingPath(item.path)}
                        aria-label="Delete workflow"
                        type="button"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
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
