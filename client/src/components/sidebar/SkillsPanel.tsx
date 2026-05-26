import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { SkillEntry } from '../../../../src/server/api/skills.ts'
import './SkillsPanel.css'

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.skills()
      .then(setSkills)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load skills'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="skills-panel__status">Loading skills...</div>
  if (error) return <div className="skills-panel__status skills-panel__status--error">Error: {error}</div>

  // Group by source
  const grouped = new Map<string, SkillEntry[]>()
  for (const skill of skills) {
    const group = grouped.get(skill.source) ?? []
    group.push(skill)
    grouped.set(skill.source, group)
  }

  return (
    <div className="skills-panel">
      {skills.length === 0 && (
        <div className="skills-panel__status">
          No skills found. Add skills to ~/.claude/skills/ or install plugins.
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
              onDragStart={(e) =>
                e.dataTransfer.setData('application/cwc-skill', JSON.stringify({ namespacedSlug: skill.namespacedSlug }))
              }
            >
              <strong className="skills-panel__name">{skill.name}</strong>
              {skill.description && <p className="skills-panel__desc">{skill.description}</p>}
              <span className="skills-panel__slug">{skill.namespacedSlug}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
