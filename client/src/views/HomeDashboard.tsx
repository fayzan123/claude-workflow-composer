import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'
import { TemplatePicker } from '../components/TemplatePicker.tsx'
import { HelpModal } from '../components/HelpModal.tsx'
import { NeedsYou } from '../components/dashboard/NeedsYou.tsx'
import { RecentActivity } from '../components/dashboard/RecentActivity.tsx'
import { AutomationsGlance } from '../components/dashboard/AutomationsGlance.tsx'
import './HomeDashboard.css'

export function HomeDashboard() {
  const navigate = useNavigate()
  const [showHelp, setShowHelp] = useState(false)

  // TemplatePicker calls onSelect after creating/loading a workflow.
  // We navigate to the workflow's Build mode by meta.id.
  function handleSelect(cwc: CwcFile, _path: string) {
    navigate(`/w/${cwc.meta.id}/build`)
  }

  // TemplatePicker calls onOpenRecent with the file path; we need the id.
  async function handleOpenRecent(path: string): Promise<void> {
    const cwc = await api.workflows.read(path)
    try { await api.recents.add(path) } catch { /* non-critical */ }
    navigate(`/w/${cwc.meta.id}/build`)
  }

  return (
    <div className="home-dashboard">
      <div className="home-dashboard__widgets">
        <NeedsYou />
        <RecentActivity />
        <AutomationsGlance />
      </div>
      <TemplatePicker onSelect={handleSelect} onOpenRecent={handleOpenRecent} />
      <button
        className="home-dashboard__help-btn"
        onClick={() => setShowHelp(true)}
        type="button"
        aria-label="Help"
        title="Help"
      >
        ?
      </button>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  )
}
