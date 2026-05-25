import React, { useState } from 'react'
import type { CwcFile } from './types.ts'
import { api } from './lib/api.ts'
import { TemplatePicker } from './components/TemplatePicker.tsx'
import './App.css'

type Screen = 'home' | 'editor'

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [workflow, setWorkflow] = useState<CwcFile | null>(null)
  const [workflowPath, setWorkflowPath] = useState<string | null>(null)

  function openWorkflow(cwc: CwcFile, path: string) {
    setWorkflow(cwc)
    setWorkflowPath(path)
    setScreen('editor')
  }

  async function handleOpenRecent(path: string) {
    try {
      const cwc = await api.workflows.read(path)
      await api.recents.add(path)
      openWorkflow(cwc, path)
    } catch {
      // file may have been deleted; silently ignore (recents list will refresh on next load)
    }
  }

  if (screen === 'home') {
    return (
      <div className="app">
        <TemplatePicker onSelect={openWorkflow} onOpenRecent={handleOpenRecent} />
      </div>
    )
  }

  return (
    <div className="app">
      {/* WorkflowEditor rendered here in Task 15+ */}
      <p>Editor for: {workflow?.meta.name}</p>
    </div>
  )
}
