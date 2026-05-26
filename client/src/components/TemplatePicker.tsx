import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { CwcFile } from '../types.ts'
import './TemplatePicker.css'

interface Props {
  onSelect: (cwc: CwcFile, path: string) => void
  onOpenRecent: (path: string) => void
}

type Tab = 'new' | 'recent'

export function TemplatePicker({ onSelect, onOpenRecent }: Props) {
  const [recents, setRecents] = useState<string[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('new')

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
      // file may already be gone; still remove from recents list locally
      setRecents((r) => r.filter((p) => p !== path))
    }
  }

  async function handleNewWorkflow() {
    setError(null)
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
    }
  }

  if (notInstalled) {
    return (
      <div className="template-picker__notice">
        <h2>Claude Code not found</h2>
        <p>Install Claude Code first, then relaunch <code>npx cwc</code>.</p>
      </div>
    )
  }

  return (
    <div className="template-picker">
      <header className="template-picker__header">
        <h1>Claude Workflow Composer</h1>
        <p>Start a new workflow or open an existing one</p>
      </header>

      <div className="template-picker__tabs">
        <button
          className={`template-picker__tab${activeTab === 'new' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('new')}
        >
          New Workflow
        </button>
        <button
          className={`template-picker__tab${activeTab === 'recent' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('recent')}
        >
          Recent
          {recents.length > 0 && <span className="template-picker__tab-badge">{recents.length}</span>}
        </button>
      </div>

      {error && <p className="template-picker__error">{error}</p>}

      {activeTab === 'new' && (
        <section className="template-picker__section">
          <div className="template-picker__grid">
            <button className="template-card template-card--blank" onClick={handleNewWorkflow}>
              <h3>Blank canvas</h3>
              <p className="template-card__desc">Start from scratch with your own agents and skills</p>
            </button>
          </div>
        </section>
      )}

      {activeTab === 'recent' && (
        <section className="template-picker__section">
          {recents.length === 0 ? (
            <p className="template-picker__empty">No recent workflows yet.</p>
          ) : (
            <ul className="recent-list">
              {recents.map((path) => (
                <li key={path} className="recent-item">
                  <button className="recent-item__open" onClick={() => onOpenRecent(path)}>{path}</button>
                  <button className="recent-item__delete" onClick={() => handleDelete(path)} aria-label="Delete workflow">×</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
