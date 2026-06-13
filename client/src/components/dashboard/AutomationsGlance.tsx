import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import './AutomationsGlance.css'

export function AutomationsGlance() {
  const [globalPaused, setGlobalPaused] = useState<boolean | null>(null)
  const [toggling, setToggling] = useState(false)

  useEffect(() => {
    api.automations.state().then((s) => setGlobalPaused(s.paused)).catch(() => {})
  }, [])

  async function handleToggle() {
    if (globalPaused === null) return
    setToggling(true)
    try {
      const next = !globalPaused
      await api.automations.setPaused(next)
      setGlobalPaused(next)
    } catch {
      // ignore — state unchanged
    } finally {
      setToggling(false)
    }
  }

  if (globalPaused === null) return null

  return (
    <div className="automations-glance">
      <div className="automations-glance__row">
        <div className="automations-glance__label">
          <h2 className="automations-glance__heading">Automations</h2>
          <p className="automations-glance__desc">
            {globalPaused ? 'All automations are paused globally.' : 'Automations are running.'}
          </p>
        </div>
        <button
          className={`automations-glance__toggle${globalPaused ? ' automations-glance__toggle--paused' : ''}`}
          onClick={handleToggle}
          disabled={toggling}
          type="button"
          aria-pressed={!globalPaused}
          title={globalPaused ? 'Resume all automations' : 'Pause all automations'}
        >
          {globalPaused ? 'Resume' : 'Pause all'}
        </button>
      </div>
    </div>
  )
}
