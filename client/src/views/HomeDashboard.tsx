import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CwcFile } from '../types.ts'
import type { ExportedWorkflowEntry } from '../../../src/server/api/exported-workflows.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'
import { api } from '../lib/api.ts'
import { TEMPLATES } from '../templates/index.ts'
import { HelpModal } from '../components/HelpModal.tsx'
import './HomeDashboard.css'

// ─── Helpers ─────────────────────────────────────────────────────────────────

type WorkflowListItem = { path: string; name: string; nodeCount: number; updated: string }
type Tab = 'new' | 'workflows' | 'deployed'

export function relativeTime(isoString: string, now = Date.now()): string {
  const diff = now - new Date(isoString).getTime()
  const sec = Math.floor(diff / 1_000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

const RUN_STATUS_LABEL: Record<string, string> = {
  running:   '● running',
  stale:     '◌ stale',
  complete:  '✓ done',
  escalated: '⚠ escalated',
  aborted:   '■ aborted',
  error:     '✕ error',
  paused:    '⏸ paused',
}

// ─── Icons (inline, no extra dep) ────────────────────────────────────────────

function IconLayers({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
    </svg>
  )
}

function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  )
}

function IconFile({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function IconActivity({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function IconTrash({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function IconInfo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function HomeDashboard() {
  const navigate = useNavigate()

  // ── Workflow state
  const [activeTab, setActiveTab] = useState<Tab>('new')
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [deployed, setDeployed] = useState<ExportedWorkflowEntry[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  // ── Widget state
  const [paused, setPaused] = useState<RunSummary[]>([])
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>([])
  const [globalPaused, setGlobalPaused] = useState<boolean | null>(null)
  const [toggling, setToggling] = useState(false)
  const [servicePersistent, setServicePersistent] = useState<boolean | null>(null)

  // ── Help modal
  const [showHelp, setShowHelp] = useState(false)

  // ── Initial data fetches
  useEffect(() => {
    api.claudeCheck().then((r) => { if (!r.installed) setNotInstalled(true) }).catch(() => {})
    api.workflows.list().then((items) => {
      setWorkflows(items.slice().sort((a, b) => b.updated.localeCompare(a.updated)))
    }).catch(() => {})
    api.exportedWorkflows.list().then(setDeployed).catch(() => {})
    api.runs.paused().then(setPaused).catch(() => setPaused([]))
    api.runs.recent(20).then(setRecentRuns).catch(() => setRecentRuns([]))
    api.automations.state().then((s) => setGlobalPaused(s.paused)).catch(() => {})
    api.serviceStatus().then((s) => setServicePersistent(s.persistent)).catch(() => {})
  }, [])

  // ── Live reload workflows on that tab
  useEffect(() => {
    if (activeTab !== 'workflows') return
    const interval = setInterval(() => {
      api.workflows.list().then((items) => {
        setWorkflows(prev => {
          const sorted = items.slice().sort((a, b) => b.updated.localeCompare(a.updated))
          if (sorted.length === prev.length && sorted.every((w, i) => w.path === prev[i]?.path)) return prev
          return sorted
        })
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [activeTab])

  // ── Dismiss confirm on outside click / Esc
  useEffect(() => {
    if (!deletingPath && !deletingSlug) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setDeletingPath(null); setDeletingSlug(null) }
    }
    function handleClick(e: MouseEvent) {
      if (!confirmRef.current?.contains(e.target as Node)) {
        setDeletingPath(null); setDeletingSlug(null)
      }
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [deletingPath, deletingSlug])

  // ── Navigation
  function handleSelect(cwc: CwcFile, _path: string) {
    navigate(`/w/${cwc.meta.id}/build`)
  }

  async function handleOpenRecent(path: string): Promise<void> {
    const cwc = await api.workflows.read(path)
    try { await api.recents.add(path) } catch { /* non-critical */ }
    navigate(`/w/${cwc.meta.id}/build`)
  }

  // ── Create helpers
  async function createAndOpen(cwc: CwcFile) {
    setError(null)
    setCreating(true)
    try {
      const pathRes = await fetch(`/api/workflows/default-path?name=${encodeURIComponent(cwc.meta.name)}`)
      const { path: resolvedPath } = await pathRes.json() as { path: string }
      await api.workflows.save(resolvedPath, cwc)
      await api.recents.add(resolvedPath)
      handleSelect(cwc, resolvedPath)
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

  // ── Delete workflow
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

  // ── Delete deployed
  async function handleDeleteDeployed(slug: string) {
    try {
      await api.exportedWorkflows.delete(slug)
    } catch { /* best-effort */ } finally {
      setDeployed((ds) => ds.filter((d) => d.slug !== slug))
      setDeletingSlug(null)
    }
  }

  // ── Global pause toggle
  async function handleToggleAutomations() {
    if (globalPaused === null) return
    setToggling(true)
    try {
      const next = !globalPaused
      await api.automations.setPaused(next)
      setGlobalPaused(next)
    } catch { /* ignore */ } finally {
      setToggling(false)
    }
  }

  // ─── Claude not installed ─────────────────────────────────────────────────

  if (notInstalled) {
    return (
      <div className="home-dashboard">
        <div className="hd-not-installed">
          <div className="hd-not-installed__inner">
            <div className="hd-not-installed__icon">
              <IconInfo size={36} />
            </div>
            <h2 className="hd-not-installed__title">Claude Code not found</h2>
            <p className="hd-not-installed__desc">
              Install Claude Code first, then relaunch <code>npx cwc</code>.
            </p>
          </div>
        </div>
        <button
          className="hd-bar__help"
          onClick={() => setShowHelp(true)}
          type="button"
          aria-label="Help"
          style={{ position: 'fixed', bottom: 'var(--space-xl)', right: 'var(--space-xl)', zIndex: 50 }}
        >?</button>
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      </div>
    )
  }

  // ─── Main layout ──────────────────────────────────────────────────────────

  return (
    <div className="home-dashboard">
      {/* ── Brand bar ── */}
      <header className="hd-bar">
        <div className="hd-bar__brand">
          <span className="hd-bar__icon" aria-hidden="true">
            <IconLayers size={20} />
          </span>
          <span className="hd-bar__name">Workflow Composer</span>
          <span className="hd-bar__tagline">
            Compose multi-agent Claude Code workflows
          </span>
        </div>
        <div className="hd-bar__actions">
          <button
            className="hd-bar__cta"
            onClick={handleNewWorkflow}
            disabled={creating}
            type="button"
          >
            <IconPlus size={14} />
            New workflow
          </button>
          <button
            className="hd-bar__help"
            onClick={() => setShowHelp(true)}
            type="button"
            aria-label="Help"
          >
            ?
          </button>
        </div>
      </header>

      {/* ── Pending approvals alert ── */}
      {paused.length > 0 && (
        <div className="hd-alert" role="alert">
          <div className="hd-alert__inner">
            <span className="hd-alert__label">
              <span className="hd-alert__dot" aria-hidden="true" />
              Needs approval
            </span>
            <div className="hd-alert__items">
              {paused.map((run) => (
                <button
                  key={run.runId}
                  className="hd-alert__run"
                  type="button"
                  onClick={() => navigate(`/w/${run.workflowId}/runs`)}
                >
                  <span className="hd-alert__run-slug">
                    {run.workflowSlug ?? run.workflowId}
                  </span>
                  <span className="hd-alert__run-when">
                    {relativeTime(run.startedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Main two-column area ── */}
      <div className="hd-content">

        {/* ── Left: workflow panel ── */}
        <main className="hd-main">

          {error && (
            <div className="hd-error" role="alert">
              <IconInfo size={14} />
              {error}
            </div>
          )}

          {/* Tab strip */}
          <div className="hd-tabs" role="tablist">
            <button
              className={`hd-tab${activeTab === 'new' ? ' hd-tab--active' : ''}`}
              onClick={() => setActiveTab('new')}
              type="button"
              role="tab"
              aria-selected={activeTab === 'new'}
            >
              <IconPlus size={12} />
              New
            </button>
            <button
              className={`hd-tab${activeTab === 'workflows' ? ' hd-tab--active' : ''}`}
              onClick={() => setActiveTab('workflows')}
              type="button"
              role="tab"
              aria-selected={activeTab === 'workflows'}
            >
              <IconFile size={12} />
              Workflows
              {workflows.length > 0 && (
                <span className="hd-tab__badge">{workflows.length}</span>
              )}
            </button>
            <button
              className={`hd-tab${activeTab === 'deployed' ? ' hd-tab--active' : ''}`}
              onClick={() => setActiveTab('deployed')}
              type="button"
              role="tab"
              aria-selected={activeTab === 'deployed'}
            >
              <IconActivity size={12} />
              Deployed
              {deployed.length > 0 && (
                <span className="hd-tab__badge">{deployed.length}</span>
              )}
            </button>
          </div>

          {/* ── New tab ── */}
          {activeTab === 'new' && (
            <section aria-label="Create a workflow">
              {/* Blank canvas */}
              <button
                className="hd-blank-card"
                onClick={handleNewWorkflow}
                disabled={creating}
                type="button"
              >
                <div className="hd-blank-card__plus" aria-hidden="true">
                  <IconPlus size={18} />
                </div>
                <div className="hd-blank-card__text">
                  <span className="hd-blank-card__title">Blank canvas</span>
                  <span className="hd-blank-card__desc">
                    Start from scratch — drag agents, wire handoffs, export
                  </span>
                </div>
              </button>

              {/* Starter templates */}
              <p className="hd-section-heading">Starter templates</p>
              <div className="hd-templates-grid">
                {TEMPLATES.map((tmpl) => (
                  <button
                    key={tmpl.id}
                    className="hd-template-card"
                    onClick={() => handleTemplateSelect(tmpl.id)}
                    disabled={creating}
                    type="button"
                  >
                    <div className="hd-template-card__meta">
                      <span className="hd-template-card__count">{tmpl.nodeCount} agents</span>
                      {tmpl.tags.map((tag) => (
                        <span key={tag} className="hd-template-card__tag">{tag}</span>
                      ))}
                    </div>
                    <span className="hd-template-card__name">{tmpl.name}</span>
                    <span className="hd-template-card__desc">{tmpl.description}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Workflows tab ── */}
          {activeTab === 'workflows' && (
            <section aria-label="Saved workflows">
              {workflows.length === 0 ? (
                <div className="hd-empty">
                  <div className="hd-empty__icon" aria-hidden="true">
                    <IconFile size={28} />
                  </div>
                  <p className="hd-empty__title">No workflows yet</p>
                  <p className="hd-empty__hint">
                    Create a new workflow from the New tab to get started.
                  </p>
                </div>
              ) : (
                <ul className="hd-list" role="list">
                  {workflows.map((item) => {
                    const dir = shortenPath(item.path).replace(/\/[^/]*\.cwc$/, '')
                    const isConfirming = deletingPath === item.path
                    return (
                      <li
                        key={item.path}
                        className={`hd-list-item${isConfirming ? ' hd-list-item--confirming' : ''}`}
                      >
                        <button
                          className="hd-list-item__btn"
                          type="button"
                          onClick={() => {
                            handleOpenRecent(item.path).catch(() => {
                              setWorkflows((ws) => ws.filter((w) => w.path !== item.path))
                              setError('That workflow was deleted or moved.')
                            })
                          }}
                        >
                          <span className="hd-list-item__icon" aria-hidden="true">
                            <IconFile size={16} />
                          </span>
                          <span className="hd-list-item__info">
                            <span className="hd-list-item__name">{item.name}</span>
                            <span className="hd-list-item__meta">
                              {item.nodeCount} agent{item.nodeCount !== 1 ? 's' : ''} · {relativeTime(item.updated)}
                            </span>
                            <span className="hd-list-item__dir">{dir}</span>
                          </span>
                        </button>
                        {isConfirming ? (
                          <div ref={confirmRef} className="hd-confirm">
                            <span className="hd-confirm__msg">Delete?</span>
                            <button
                              className="hd-confirm__btn hd-confirm__btn--yes"
                              onClick={() => handleDelete(item.path)}
                              type="button"
                            >Delete</button>
                            <button
                              className="hd-confirm__btn hd-confirm__btn--no"
                              onClick={() => setDeletingPath(null)}
                              type="button"
                            >Cancel</button>
                          </div>
                        ) : (
                          <button
                            className="hd-list-item__delete"
                            onClick={() => setDeletingPath(item.path)}
                            aria-label={`Delete ${item.name}`}
                            type="button"
                          >
                            <IconTrash />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}

          {/* ── Deployed tab ── */}
          {activeTab === 'deployed' && (
            <section aria-label="Deployed workflows">
              {deployed.length === 0 ? (
                <div className="hd-empty">
                  <div className="hd-empty__icon" aria-hidden="true">
                    <IconActivity size={28} />
                  </div>
                  <p className="hd-empty__title">No deployed workflows</p>
                  <p className="hd-empty__hint">
                    Export a workflow to write it as a Claude Code skill — it will appear here.
                  </p>
                </div>
              ) : (
                <ul className="hd-list" role="list">
                  {deployed.map((item) => {
                    const isConfirming = deletingSlug === item.slug
                    return (
                      <li
                        key={item.slug}
                        className={`hd-list-item${isConfirming ? ' hd-list-item--confirming' : ''}`}
                      >
                        <div className="hd-list-item__btn hd-list-item__btn--static">
                          <span className="hd-list-item__icon" aria-hidden="true">
                            <IconActivity size={16} />
                          </span>
                          <span className="hd-list-item__info">
                            <span className="hd-list-item__name">{item.name}</span>
                            {item.description && (
                              <span className="hd-list-item__meta">{item.description}</span>
                            )}
                            <span className="hd-list-item__dir">~/.claude/skills/{item.slug}</span>
                          </span>
                        </div>
                        {isConfirming ? (
                          <div ref={confirmRef} className="hd-confirm">
                            <span className="hd-confirm__msg">Remove from Claude?</span>
                            <button
                              className="hd-confirm__btn hd-confirm__btn--yes"
                              onClick={() => handleDeleteDeployed(item.slug)}
                              type="button"
                            >Remove</button>
                            <button
                              className="hd-confirm__btn hd-confirm__btn--no"
                              onClick={() => setDeletingSlug(null)}
                              type="button"
                            >Cancel</button>
                          </div>
                        ) : (
                          <button
                            className="hd-list-item__delete"
                            onClick={() => setDeletingSlug(item.slug)}
                            aria-label={`Remove ${item.name}`}
                            type="button"
                          >
                            <IconTrash />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}
        </main>

        {/* ── Right rail ── */}
        <aside className="hd-rail" aria-label="Dashboard overview">

          {/* Recent runs — only when non-empty */}
          {recentRuns.length > 0 && (
            <div className="hd-widget">
              <h2 className="hd-widget__heading">Recent runs</h2>
              <ul className="hd-runs" role="list">
                {recentRuns.map((run) => (
                  <li key={run.runId} className="hd-runs__item">
                    <button
                      className="hd-runs__row"
                      type="button"
                      onClick={() => navigate(`/w/${run.workflowId}/runs`)}
                    >
                      <span className="hd-runs__slug">{run.workflowSlug}</span>
                      <span className={`hd-runs__status hd-runs__status--${run.status}`}>
                        {RUN_STATUS_LABEL[run.status] ?? run.status}
                      </span>
                      <span className="hd-runs__when">{relativeTime(run.startedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Automations glance — only when loaded */}
          {globalPaused !== null && (
            <div className="hd-widget">
              <h2 className="hd-widget__heading">Automations</h2>
              <div className="hd-auto">
                <div className="hd-auto__label">
                  <p className="hd-auto__status">
                    {globalPaused ? 'Paused globally' : 'Running'}
                  </p>
                  <p className="hd-auto__desc">
                    {globalPaused
                      ? 'All triggers are suppressed.'
                      : 'Scheduled triggers are active.'}
                  </p>
                </div>
                <button
                  className={`hd-auto__toggle${globalPaused ? ' hd-auto__toggle--paused' : ''}`}
                  onClick={handleToggleAutomations}
                  disabled={toggling}
                  type="button"
                  aria-pressed={!globalPaused}
                  title={globalPaused ? 'Resume all automations' : 'Pause all automations'}
                >
                  {globalPaused ? 'Resume' : 'Pause all'}
                </button>
              </div>
              {servicePersistent !== null && (
                <p className="hd-auto__persistence">
                  {servicePersistent
                    ? 'Runs at login — the server restarts automatically.'
                    : 'Session-bound — stops on reboot. Run `npx cwc install-service` for 24/7.'}
                </p>
              )}
            </div>
          )}
        </aside>
      </div>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  )
}
