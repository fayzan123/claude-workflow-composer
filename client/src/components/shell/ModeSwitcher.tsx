import React from 'react'
import { useNavigate } from 'react-router-dom'
import './ModeSwitcher.css'

type Mode = 'build' | 'runs' | 'automate'

interface Props {
  id: string
  active: Mode
  pausedCount: number
}

const MODES: { key: Mode; label: string }[] = [
  { key: 'build', label: 'Build' },
  { key: 'runs', label: 'Runs' },
  { key: 'automate', label: 'Automate' },
]

export function ModeSwitcher({ id, active, pausedCount }: Props) {
  const navigate = useNavigate()

  return (
    <nav className="mode-switcher" aria-label="Workflow modes">
      {MODES.map(({ key, label }) => {
        const isActive = key === active
        const showBadge = key === 'runs' && pausedCount > 0
        return (
          <button
            key={key}
            className={`mode-switcher__tab${isActive ? ' mode-switcher__tab--active' : ''}`}
            onClick={() => navigate(`/w/${id}/${key}`)}
            type="button"
            aria-current={isActive ? 'page' : undefined}
          >
            {showBadge ? `⏸ ${pausedCount} to approve` : label}
          </button>
        )
      })}
    </nav>
  )
}
