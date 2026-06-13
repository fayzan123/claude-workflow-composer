import React, { useState, useCallback } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '../../components/Canvas.tsx'
import { Sidebar } from '../../components/Sidebar.tsx'
import { NodePanel } from '../../components/panels/NodePanel.tsx'
import { EdgePanel } from '../../components/panels/EdgePanel.tsx'
import { OrchestratorPreview } from '../../components/OrchestratorPreview.tsx'
import { RunPanel } from '../../components/RunPanel.tsx'
import { ExportFlow } from '../../components/ExportFlow.tsx'
import { RunModal } from '../../components/RunModal.tsx'
import { HelpModal } from '../../components/HelpModal.tsx'
import { TopBar } from '../../components/TopBar.tsx'
import { validateWorkflow } from '../../lib/validation.ts'
import type { ModeProps } from '../modeProps.ts'
import './BuildMode.css'

// NOTE: node/edge selection state is local to BuildMode intentionally.
// Selection is purely a canvas-interaction concern — it drives which side panel
// is shown but never needs to persist across mode switches. Keeping it local
// also means WorkflowView stays clean and doesn't accumulate UI-only state.

interface Props extends ModeProps {
  isSaving: boolean
  saveError: Error | null
  renameError: string | null
  isDirty: boolean
  canUndo: boolean
  canRedo: boolean
  onRename: (newName: string) => void
  onDismissSaveError: () => void
  onHome: () => void
  onLeaveConfirm: () => void
  onLeaveCancel: () => void
  showLeaveConfirm: boolean
}

export function BuildMode({
  workflow,
  dispatch,
  runState,
  workflowSlug,
  isSaving,
  saveError,
  renameError,
  isDirty: _isDirty,
  canUndo,
  canRedo,
  onRename,
  onDismissSaveError,
  onHome,
  onLeaveConfirm,
  onLeaveCancel,
  showLeaveConfirm,
}: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showRunModal, setShowRunModal] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showRuns, setShowRuns] = useState(false)

  const validation = validateWorkflow(workflow)

  // Derive node run states from live run events for canvas pulse animation
  const nodeRunStates: Record<string, 'active' | 'done'> = {}
  if (runState.activeRun) {
    for (const e of runState.liveEvents) {
      if (e.type === 'step_started' && e.nodeId) nodeRunStates[e.nodeId] = 'active'
      if (e.type === 'step_completed' && e.nodeId) nodeRunStates[e.nodeId] = 'done'
    }
  }

  function viewTransition(fn: () => void) {
    if (document.startViewTransition) {
      document.startViewTransition(fn)
    } else {
      fn()
    }
  }

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
      if (!open) {
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
      }
      return !open
    })
  }, [])

  const selectedNode = selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? workflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const isEntryNode = selectedNode ? !workflow.edges.some((e) => e.to === selectedNode.id) : false
  const terminalEdge = selectedNode ? (workflow.edges.find((e) => e.from === selectedNode.id && e.to === null) ?? null) : null
  const helpTab = selectedNode ? 'nodes' : selectedEdge ? 'edges' : undefined

  return (
    <div className="build-mode">
      {/* Reuse TopBar exactly as App.tsx used it — all its functionality preserved */}
      <TopBar
        workflow={workflow}
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
        onHome={onHome}
        onTestRun={() => setShowRunModal(true)}
        onToggleRuns={() => setShowRuns(s => !s)}
        runActive={runState.activeRun !== null}
        pausedCount={runState.pausedRuns.length}
        onRename={onRename}
        onLeaveConfirm={onLeaveConfirm}
        onLeaveCancel={onLeaveCancel}
        onDismissSaveError={onDismissSaveError}
      />
      <div className="build-mode__body">
        <Sidebar />
        <ReactFlowProvider>
          <Canvas
            workflow={workflow}
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
            workflow={workflow}
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
            nodes={workflow.nodes}
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
            workflow={workflow}
            onClose={() => setShowPreview(false)}
          />
        )}
        {!selectedNode && !selectedEdge && !showPreview && showRuns && (
          <RunPanel
            workflowId={workflow.meta.id}
            runs={runState.runs}
            liveEvents={runState.liveEvents}
            activeRun={runState.activeRun}
            pausedRuns={runState.pausedRuns}
            onClose={() => setShowRuns(false)}
            onChanged={runState.refresh}
          />
        )}
      </div>
      {showExport && (
        <ExportFlow
          workflow={workflow}
          dispatch={dispatch}
          onClose={() => setShowExport(false)}
        />
      )}
      {showRunModal && (
        <RunModal
          workflowId={workflow.meta.id}
          workflowSlug={workflowSlug}
          onStarted={() => setShowRuns(true)}
          onClose={() => setShowRunModal(false)}
          onExport={() => setShowExport(true)}
        />
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} initialTab={helpTab} />}
    </div>
  )
}
