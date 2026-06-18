import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { AgentEntry } from '../../../../src/server/api/agents.ts'
import { MarkdownViewer } from '../MarkdownViewer.tsx'
import { GenerateAgentModal } from '../GenerateAgentModal.tsx'
import './MyAgentsTab.css'

export function MyAgentsTab() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<{ filePath: string; title: string } | null>(null)
  const [generating, setGenerating] = useState(false)
  const isDragging = useRef(false)

  // silent=true refreshes the list in the background without flipping the
  // loading early-return (which would unmount any open modal).
  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true)
    api.agents()
      .then(setAgents)
      .catch((err: unknown) => { if (!silent) setError(err instanceof Error ? err.message : 'Failed to load agents') })
      .finally(() => { if (!silent) setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete(agent: AgentEntry) {
    if (!window.confirm(`Delete agent "${agent.name}"?\n\nThis removes ${agent.filePath} and can't be undone.`)) return
    try {
      await api.deleteAgent(agent.filePath)
      load(true)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (loading) return <div className="my-agents__status">Loading agents...</div>
  if (error) return <div className="my-agents__status my-agents__status--error">Error: {error}</div>

  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.trim().toLowerCase()))
    : agents

  // Group by source
  const grouped = new Map<string, AgentEntry[]>()
  for (const agent of filtered) {
    const group = grouped.get(agent.source) ?? []
    group.push(agent)
    grouped.set(agent.source, group)
  }

  return (
    <div className="my-agents">
      <button className="my-agents__generate" onClick={() => setGenerating(true)}>
        <span className="my-agents__generate-label">✨ Generate agent</span>
        <span className="my-agents__generate-sub">Describe it in plain English — AI builds it</span>
      </button>
      <div className="my-agents__search-wrap">
        <input
          className="my-agents__search"
          type="search"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="my-agents__list">
        <div className="my-agents__quick-cards">
          <div
            className="my-agents__card my-agents__card--quick"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                'application/cwc-agent',
                JSON.stringify({ name: 'New Agent', description: '', completionCriteria: '', systemPrompt: '', tools: [], skills: [] })
              )
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <strong className="my-agents__name">+ New Agent</strong>
            <span className="my-agents__slug">drag to canvas</span>
          </div>
          <div
            className="my-agents__card my-agents__card--quick my-agents__card--gate"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/cwc-gate', JSON.stringify({}))
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <strong className="my-agents__name">Approval Gate</strong>
            <span className="my-agents__slug">Pauses the run for your sign-off</span>
          </div>
        </div>
        {grouped.size === 0 && (
          search ? (
            <div className="my-agents__status">No agents match your search.</div>
          ) : (
            <div className="my-agents__empty">
              <p className="my-agents__empty-title">Start by creating an agent</p>
              <p className="my-agents__empty-body">
                Use <strong>Generate agent</strong> above to describe one in plain English,
                or drag <strong>New Agent</strong> onto the canvas to build it yourself.
              </p>
              <p className="my-agents__empty-hint">
                Already have agent files in <code>~/.claude/agents/</code>? They'll show up here automatically.
              </p>
            </div>
          )
        )}
        {Array.from(grouped.entries()).map(([source, sourceAgents]) => (
          <div key={source} className="my-agents__group">
            <div className="my-agents__group-label">{source === 'user' ? 'User (~/.claude/agents)' : 'Project (.claude/agents)'}</div>
            {sourceAgents.map((agent) => (
              <div
                key={agent.filePath}
                className="my-agents__card"
                draggable
                onDragStart={(e) => {
                  isDragging.current = true
                  e.dataTransfer.setData(
                    'application/cwc-agent-ref',
                    JSON.stringify({
                      agentRef: agent.slug,
                      name: agent.name,
                      description: agent.description,
                    })
                  )
                }}
                onDragEnd={() => {
                  isDragging.current = false
                }}
                onClick={() => {
                  if (!isDragging.current) setViewing({ filePath: agent.filePath, title: agent.name })
                }}
              >
                <button
                  className="my-agents__delete"
                  title="Delete agent"
                  draggable={false}
                  onClick={(e) => { e.stopPropagation(); handleDelete(agent) }}
                >🗑</button>
                <strong className="my-agents__name">{agent.name}</strong>
                {agent.description && <p className="my-agents__desc">{agent.description}</p>}
                <span className="my-agents__slug">{agent.slug}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {viewing && (
        <MarkdownViewer
          filePath={viewing.filePath}
          title={viewing.title}
          onClose={() => setViewing(null)}
          onSaved={() => load(true)}
        />
      )}
      <GenerateAgentModal
        open={generating}
        onClose={() => setGenerating(false)}
        onCreated={() => load(true)}
      />
    </div>
  )
}
