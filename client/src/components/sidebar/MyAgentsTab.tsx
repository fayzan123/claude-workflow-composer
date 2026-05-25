import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { AgentEntry } from '../../../../src/server/api/agents.ts'
import './MyAgentsTab.css'

export function MyAgentsTab() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    api.agents()
      .then(setAgents)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load agents'))
      .finally(() => setLoading(false))
  }, [])

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
        {grouped.size === 0 && (
          <div className="my-agents__status">
            {search ? 'No agents match your search.' : 'No agents found. Add .md agent files to ~/.claude/agents/.'}
          </div>
        )}
        {Array.from(grouped.entries()).map(([source, sourceAgents]) => (
          <div key={source} className="my-agents__group">
            <div className="my-agents__group-label">{source === 'user' ? 'User (~/.claude/agents)' : 'Project (.claude/agents)'}</div>
            {sourceAgents.map((agent) => (
              <div
                key={agent.filePath}
                className="my-agents__card"
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData(
                    'application/cwc-agent',
                    JSON.stringify({
                      name: agent.name,
                      description: agent.description,
                      systemPrompt: '',
                      completionCriteria: '',
                      tools: [],
                      skills: [agent.slug],
                      model: 'inherit',
                    })
                  )
                }
              >
                <strong className="my-agents__name">{agent.name}</strong>
                {agent.description && <p className="my-agents__desc">{agent.description}</p>}
                <span className="my-agents__slug">{agent.slug}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
