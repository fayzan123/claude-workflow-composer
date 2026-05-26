import React, { useState, useCallback } from 'react'
import type { CwcFile } from './types.ts'
import { api } from './lib/api.ts'
import { TemplatePicker } from './components/TemplatePicker.tsx'
import { useWorkflow } from './hooks/useWorkflow.ts'
import { useAutoSave } from './hooks/useAutoSave.ts'
import { validateWorkflow } from './lib/validation.ts'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './components/Canvas.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { NodePanel } from './components/panels/NodePanel.tsx'
import { EdgePanel } from './components/panels/EdgePanel.tsx'
import { TopBar } from './components/TopBar.tsx'
import { ExportFlow } from './components/ExportFlow.tsx'
import './App.css'

type Screen = 'home' | 'editor'

function viewTransition(fn: () => void) {
  if (document.startViewTransition) {
    document.startViewTransition(fn)
  } else {
    fn()
  }
}

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

  const handleSelectNode = useCallback((id: string | null) => {
    viewTransition(() => {
      setSelectedNodeId(id)
      if (id) setSelectedEdgeId(null)
    })
  }, [])

  const handleSelectEdge = useCallback((id: string | null) => {
    viewTransition(() => {
      setSelectedEdgeId(id)
      if (id) setSelectedNodeId(null)
    })
  }, [])

  function openWorkflow(cwc: CwcFile, path: string) {
    setWorkflow(cwc)
    setWorkflowPath(path)
    dispatch({ type: 'LOAD', payload: cwc })
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
  const terminalEdge = selectedNode ? (editorWorkflow.edges.find((e) => e.from === selectedNode.id && e.to === null) ?? null) : null
  const projectDir = workflowPath ? workflowPath.replace(/\/[^/]*$/, '') : undefined

  return (
    <div className="app app--editor">
      <TopBar
        workflow={editorWorkflow}
        validation={validation}
        isSaving={isSaving}
        dispatch={dispatch}
        onExport={() => setShowExport(true)}
        onHome={() => { setScreen('home'); setWorkflow(null); setWorkflowPath(null) }}
      />
      <div className="app__editor-body">
        <Sidebar projectDir={projectDir} />
        <ReactFlowProvider>
        <Canvas
          workflow={editorWorkflow}
          dispatch={dispatch}
          validation={validation}
          onSelectNode={handleSelectNode}
          onSelectEdge={handleSelectEdge}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
        />
        </ReactFlowProvider>
        {selectedNode && (
          <NodePanel
            node={selectedNode}
            isEntryNode={isEntryNode}
            terminalEdge={terminalEdge}
            dispatch={dispatch}
            onClose={() => handleSelectNode(null)}
            onDelete={() => {
              dispatch({ type: 'REMOVE_NODE', payload: { nodeId: selectedNode.id } })
              handleSelectNode(null)
            }}
          />
        )}
        {selectedEdge && (
          <EdgePanel
            edge={selectedEdge}
            dispatch={dispatch}
            onClose={() => handleSelectEdge(null)}
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
