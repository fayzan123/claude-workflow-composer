import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { SkillEntry } from '../../../../src/server/api/skills.ts'
import { MarkdownViewer } from '../MarkdownViewer.tsx'
import './SkillsPanel.css'

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [viewing, setViewing] = useState<{ filePath: string; title: string } | null>(null)
  const isDragging = useRef(false)

  useEffect(() => {
    api.skills()
      .then(setSkills)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load skills'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="skills-panel__status">Loading skills...</div>
  if (error) return <div className="skills-panel__status skills-panel__status--error">Error: {error}</div>

  const filtered = search.trim()
    ? skills.filter((s) =>
        s.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        (s.description && s.description.toLowerCase().includes(search.trim().toLowerCase())) ||
        s.namespacedSlug.toLowerCase().includes(search.trim().toLowerCase())
      )
    : skills

  // Group by source
  const grouped = new Map<string, SkillEntry[]>()
  for (const skill of filtered) {
    const group = grouped.get(skill.source) ?? []
    group.push(skill)
    grouped.set(skill.source, group)
  }

  return (
    <div className="skills-panel">
      <div className="skills-panel__search-wrap">
        <input
          className="skills-panel__search"
          type="search"
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="skills-panel__list">
        {grouped.size === 0 && (
          <div className="skills-panel__status">
            {search ? 'No skills match your search.' : 'No skills found. Add skills to ~/.claude/skills/ or install plugins.'}
          </div>
        )}
        {Array.from(grouped.entries()).map(([source, sourceSkills]) => (
          <div key={source} className="skills-panel__group">
            <div className="skills-panel__group-label">
              {source === 'user' ? 'User (~/.claude/skills)' : 'Plugins'}
            </div>
            {sourceSkills.map((skill) => (
              <div
                key={skill.namespacedSlug}
                className="skills-panel__card"
                draggable
                onDragStart={(e) => {
                  isDragging.current = true
                  e.dataTransfer.setData('application/cwc-skill', JSON.stringify({ namespacedSlug: skill.namespacedSlug }))
                }}
                onDragEnd={() => {
                  isDragging.current = false
                }}
                onClick={() => {
                  if (!isDragging.current) setViewing({ filePath: skill.filePath, title: skill.name })
                }}
              >
                <strong className="skills-panel__name">{skill.name}</strong>
                {skill.description && <p className="skills-panel__desc">{skill.description}</p>}
                <span className="skills-panel__slug">{skill.namespacedSlug}</span>
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
        />
      )}
    </div>
  )
}
