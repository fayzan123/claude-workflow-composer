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
import { OrchestratorPreview } from './components/OrchestratorPreview.tsx'
import { ExportFlow } from './components/ExportFlow.tsx'
import { HelpModal } from './components/HelpModal.tsx'
import { RunModal } from './components/RunModal.tsx'
import { RunPanel } from './components/RunPanel.tsx'
import { useRunEvents } from './hooks/useRunEvents.ts'
import { slugify } from '../../src/slugify.ts'
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
  const [showPreview, setShowPreview] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showRunModal, setShowRunModal] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [saveError, setSaveError] = useState<Error | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  const { workflow: editorWorkflow, dispatch, canUndo, canRedo } = useWorkflow(workflow ?? undefined)
  const runState = useRunEvents(editorWorkflow.meta.id)
  const workflowSlug = 'cwc-' + slugify(editorWorkflow.meta.name)
  const nodeRunStates: Record<string, 'active' | 'done'> = {}
  if (runState.activeRun) {
    for (const e of runState.liveEvents) {
      if (e.type === 'step_started' && e.nodeId) nodeRunStates[e.nodeId] = 'active'
      if (e.type === 'step_completed' && e.nodeId) nodeRunStates[e.nodeId] = 'done'
    }
  }
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const validation = validateWorkflow(editorWorkflow)
  const { isSaving, isDirty, flush } = useAutoSave(editorWorkflow, workflowPath, {
    onError: (err) => setSaveError(err),
    onSuccess: () => setSaveError(null),
  })

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

  const handleTogglePreview = useCallback(() => {
    setShowPreview((open) => {
      // Opening the preview clears any node/edge selection so it owns the slot.
      if (!open) {
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
      }
      return !open
    })
  }, [])

  function openWorkflow(cwc: CwcFile, path: string) {
    setWorkflow(cwc)
    setWorkflowPath(path)
    dispatch({ type: 'LOAD', payload: cwc })
    setScreen('editor')
  }

  async function handleOpenRecent(path: string): Promise<void> {
    const cwc = await api.workflows.read(path) // throws on 404 — caller handles it
    try { await api.recents.add(path) } catch { /* non-critical */ }
    openWorkflow(cwc, path)
  }

  async function handleRename(newName: string) {
    if (!workflowPath) return
    setRenameError(null)
    try {
      await flush()
      const result = await api.workflows.rename(workflowPath, newName)
      if (result.renamed) setWorkflowPath(result.path)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  function handleHomeClick() {
    if (isDirty) {
      setShowLeaveConfirm(true)
    } else {
      goHome()
    }
  }

  function goHome() {
    setScreen('home')
    setWorkflow(null)
    setWorkflowPath(null)
    setShowLeaveConfirm(false)
    setSaveError(null)
    setRenameError(null)
  }

  if (screen === 'home') {
    return (
      <div className="app">
        <TemplatePicker onSelect={openWorkflow} onOpenRecent={handleOpenRecent} />
        <button
          className="app__home-help-btn"
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

  const selectedNode = selectedNodeId ? editorWorkflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? editorWorkflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const isEntryNode = selectedNode ? !editorWorkflow.edges.some((e) => e.to === selectedNode.id) : false
  const terminalEdge = selectedNode ? (editorWorkflow.edges.find((e) => e.from === selectedNode.id && e.to === null) ?? null) : null

  return (
    <div className="app app--editor">
      <TopBar
        workflow={editorWorkflow}
        validation={validation}
        isSaving={isSaving}
        saveError={saveError}
        renameError={renameError}
        showLeaveConfirm={showLeaveConfirm}
        dispatch={dispatch}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => dispatch({ type: 'UNDO' })}
        onRedo={() => dispatch({ type: 'REDO' })}
        previewOpen={showPreview}
        onTogglePreview={handleTogglePreview}
        onExport={() => setShowExport(true)}
        onHelp={() => setShowHelp(true)}
        onHome={handleHomeClick}
        onTestRun={() => setShowRunModal(true)}
        onToggleRuns={() => setShowRuns(s => !s)}
        runActive={runState.activeRun !== null}
        onRename={handleRename}
        onLeaveConfirm={goHome}
        onLeaveCancel={() => setShowLeaveConfirm(false)}
        onDismissSaveError={() => setSaveError(null)}
      />
      <div className="app__editor-body">
        <Sidebar />
        <ReactFlowProvider>
          <Canvas
            workflow={editorWorkflow}
            dispatch={dispatch}
            validation={validation}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            nodeRunStates={nodeRunStates}
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
            nodes={editorWorkflow.nodes}
            dispatch={dispatch}
            onClose={() => handleSelectEdge(null)}
            onDelete={() => {
              dispatch({ type: 'REMOVE_EDGE', payload: { edgeId: selectedEdge.id } })
              handleSelectEdge(null)
            }}
          />
        )}
        {!selectedNode && !selectedEdge && showPreview && (
          <OrchestratorPreview
            workflow={editorWorkflow}
            onClose={() => setShowPreview(false)}
          />
        )}
        {!selectedNode && !selectedEdge && !showPreview && showRuns && (
          <RunPanel
            workflowId={editorWorkflow.meta.id}
            runs={runState.runs}
            liveEvents={runState.liveEvents}
            activeRun={runState.activeRun}
            onClose={() => setShowRuns(false)}
          />
        )}
      </div>
      {showExport && (
        <ExportFlow
          workflow={editorWorkflow}
          dispatch={dispatch}
          onClose={() => setShowExport(false)}
        />
      )}
      {showRunModal && (
        <RunModal
          workflowId={editorWorkflow.meta.id}
          workflowSlug={workflowSlug}
          onStarted={() => setShowRuns(true)}
          onClose={() => setShowRunModal(false)}
        />
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  )
}
