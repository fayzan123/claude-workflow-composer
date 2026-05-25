import React, { useState } from 'react'
import type { CwcFile } from './types.ts'
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

  if (screen === 'home') {
    return (
      <div className="app">
        {/* TemplatePicker rendered here in Task 14 */}
        <p>Loading...</p>
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
