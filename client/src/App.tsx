import React, { useState } from 'react'
import type { CwcFile } from './types.ts'
import { api } from './lib/api.ts'
import { TemplatePicker } from './components/TemplatePicker.tsx'
import { useWorkflow } from './hooks/useWorkflow.ts'
import { useAutoSave } from './hooks/useAutoSave.ts'
import { validateWorkflow } from './lib/validation.ts'
import { Canvas } from './components/Canvas.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { NodePanel } from './components/panels/NodePanel.tsx'
import { EdgePanel } from './components/panels/EdgePanel.tsx'
import { TopBar } from './components/TopBar.tsx'
import { ExportFlow } from './components/ExportFlow.tsx'
import './App.css'

type Screen = 'home' | 'editor'

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [workflow, setWorkflow] = useState<CwcFile | null>(null)
  const [workflowPath, setWorkflowPath] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)

  const { workflow: editorWorkflow, dispatch } = useWorkflow(workflow ?? undefined)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const validation = validateWorkflow(editorWorkflow)
  const { isSaving } = useAutoSave(editorWorkflow, workflowPath)

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

  const selectedNode = selectedNodeId ? editorWorkflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? editorWorkflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const isEntryNode = selectedNode ? !editorWorkflow.edges.some((e) => e.to === selectedNode.id) : false
  const projectDir = workflowPath ? workflowPath.replace(/\/[^/]*$/, '') : undefined

  return (
    <div className="app app--editor">
      <TopBar
        workflow={editorWorkflow}
        validation={validation}
        isSaving={isSaving}
        dispatch={dispatch}
        onExport={() => setShowExport(true)}
        onHome={() => setScreen('home')}
      />
      <div className="app__editor-body">
        <Sidebar projectDir={projectDir} />
        <Canvas
          workflow={editorWorkflow}
          dispatch={dispatch}
          validation={validation}
          onSelectNode={setSelectedNodeId}
          onSelectEdge={setSelectedEdgeId}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
        />
        {selectedNode && (
          <NodePanel
            node={selectedNode}
            isEntryNode={isEntryNode}
            dispatch={dispatch}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
        {selectedEdge && (
          <EdgePanel
            edge={selectedEdge}
            dispatch={dispatch}
            onClose={() => setSelectedEdgeId(null)}
          />
        )}
      </div>
      {showExport && (
        <ExportFlow
          workflow={editorWorkflow}
          dispatch={dispatch}
          onClose={() => setShowExport(false)}
          projectDir={projectDir}
        />
      )}
    </div>
  )
}
