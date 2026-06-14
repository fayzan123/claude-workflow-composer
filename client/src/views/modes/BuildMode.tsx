import React, { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '../../components/Canvas.tsx'
import { Sidebar } from '../../components/Sidebar.tsx'
import { StepDrawer } from '../../components/build/StepDrawer.tsx'
import { OrchestratorPreview } from '../../components/OrchestratorPreview.tsx'
import { ExportFlow } from '../../components/ExportFlow.tsx'
import { RunModal } from '../../components/RunModal.tsx'
import { HelpModal } from '../../components/HelpModal.tsx'
import { WorkflowHeader } from '../../components/shell/WorkflowHeader.tsx'
import { validateWorkflow } from '../../lib/validation.ts'
import type { ModeProps } from '../modeProps.ts'
import './BuildMode.css'

// NOTE: node/edge selection state is local to BuildMode intentionally.
// Selection is purely a canvas-interaction concern — it drives which side panel
// is shown but never needs to persist across mode switches. Keeping it local
// also means WorkflowView stays clean and doesn't accumulate UI-only state.

interface Props extends ModeProps {
  workflowId: string
  isSaving: boolean
  saveError: Error | null
  renameError: string | null
  isDirty: boolean
  canUndo: boolean
  canRedo: boolean
  onRename: (newName: string) => void
  onDismissSaveError: () => void
}

export function BuildMode({
  workflow,
  dispatch,
  runState,
  workflowSlug,
  workflowId,
  isSaving,
  saveError,
  renameError,
  isDirty,
  canUndo,
  canRedo,
  onRename,
  onDismissSaveError,
}: Props) {
  const navigate = useNavigate()

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showRunModal, setShowRunModal] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  // Validation errors/warnings popovers
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const errorsPopoverRef = React.useRef<HTMLDivElement>(null)
  const errorsBadgeRef = React.useRef<HTMLButtonElement>(null)
  const warningsPopoverRef = React.useRef<HTMLDivElement>(null)
  const warningsBadgeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!errorsOpen) return
    function handleClick(e: MouseEvent) {
      if (!errorsPopoverRef.current?.contains(e.target as Node) && !errorsBadgeRef.current?.contains(e.target as Node)) {
        setErrorsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setErrorsOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey) }
  }, [errorsOpen])

  React.useEffect(() => {
    if (!warningsOpen) return
    function handleClick(e: MouseEvent) {
      if (!warningsPopoverRef.current?.contains(e.target as Node) && !warningsBadgeRef.current?.contains(e.target as Node)) {
        setWarningsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setWarningsOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey) }
  }, [warningsOpen])

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

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  function nodeNameFor(nodeId: string | undefined) {
    if (!nodeId) return null
    const node = workflow.nodes.find((n) => n.id === nodeId)
    return node?.agent.name?.trim() || 'Untitled agent'
  }

  // Build-mode action slot: undo/redo, preview, help, error/warning badges, export, test run
  const buildActions = (
    <>
      <button
        className="build-mode__action-btn"
        onClick={() => dispatch({ type: 'UNDO' })}
        disabled={!canUndo}
        type="button"
        title="Undo (⌘Z)"
        aria-label="Undo"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </svg>
      </button>
      <button
        className="build-mode__action-btn"
        onClick={() => dispatch({ type: 'REDO' })}
        disabled={!canRedo}
        type="button"
        title="Redo (⇧⌘Z)"
        aria-label="Redo"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
        </svg>
      </button>

      {hasErrors && (
        <div className="build-mode__badge-wrap">
          <button
            ref={errorsBadgeRef}
            className="build-mode__badge build-mode__badge--error"
            onClick={() => setErrorsOpen((o) => !o)}
            type="button"
            aria-expanded={errorsOpen}
          >
            {validation.errors.length} error{validation.errors.length !== 1 ? 's' : ''}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
              <polyline points={errorsOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
          {errorsOpen && (
            <div ref={errorsPopoverRef} className="build-mode__popover build-mode__popover--error" role="dialog" aria-label="Workflow errors">
              <p className="build-mode__popover-heading">Fix before exporting</p>
              <ul className="build-mode__popover-list">
                {validation.errors.map((err, i) => (
                  <li key={i} className="build-mode__popover-item">
                    <span className="build-mode__popover-msg">{err.message}</span>
                    {err.nodeId && <span className="build-mode__popover-node">{nodeNameFor(err.nodeId)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!hasErrors && hasWarnings && (
        <div className="build-mode__badge-wrap">
          <button
            ref={warningsBadgeRef}
            className="build-mode__badge build-mode__badge--warning"
            onClick={() => setWarningsOpen((o) => !o)}
            type="button"
            aria-expanded={warningsOpen}
          >
            {validation.warnings.length} warning{validation.warnings.length !== 1 ? 's' : ''}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
              <polyline points={warningsOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
          {warningsOpen && (
            <div ref={warningsPopoverRef} className="build-mode__popover build-mode__popover--warning" role="dialog" aria-label="Workflow warnings">
              <p className="build-mode__popover-heading">Warnings</p>
              <ul className="build-mode__popover-list">
                {validation.warnings.map((w, i) => (
                  <li key={i} className="build-mode__popover-item">
                    <span className="build-mode__popover-msg">{w.message}</span>
                    {w.nodeId && <span className="build-mode__popover-node">{nodeNameFor(w.nodeId)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <button
        className="build-mode__action-btn"
        onClick={() => setShowHelp(true)}
        type="button"
        title="Help"
        aria-label="Help"
      >
        ?
      </button>

      <button
        className={`build-mode__action-btn${showPreview ? ' build-mode__action-btn--active' : ''}`}
        onClick={handleTogglePreview}
        type="button"
        title="Toggle orchestrator preview"
        aria-pressed={showPreview}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Preview
      </button>

      <button
        className={`build-mode__action-btn${runState.activeRun !== null ? ' build-mode__action-btn--active' : ''}`}
        onClick={() => setShowRunModal(true)}
        type="button"
        title="Run this workflow headlessly"
      >
        {runState.activeRun !== null ? '● Running…' : '▶ Test Run'}
      </button>

      <button
        className="build-mode__export-btn"
        onClick={() => setShowExport(true)}
        disabled={!validation.canExport}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export
      </button>
    </>
  )

  return (
    <div className="build-mode">
      <WorkflowHeader
        workflow={workflow}
        dispatch={dispatch}
        workflowId={workflowId}
        activeMode="build"
        pausedCount={runState.pausedRuns.length}
        isSaving={isSaving}
        saveError={saveError}
        renameError={renameError}
        isDirty={isDirty}
        onRename={onRename}
        onDismissSaveError={onDismissSaveError}
        actions={buildActions}
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
        <StepDrawer
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          isEntryNode={isEntryNode}
          terminalEdge={terminalEdge}
          workflow={workflow}
          dispatch={dispatch}
          onClose={() => {
            handleSelectNode(null)
            handleSelectEdge(null)
          }}
          onDeleteNode={() => {
            if (selectedNode) {
              dispatch({ type: 'REMOVE_NODE', payload: { nodeId: selectedNode.id } })
              handleSelectNode(null)
            }
          }}
          onDeleteEdge={() => {
            if (selectedEdge) {
              dispatch({ type: 'REMOVE_EDGE', payload: { edgeId: selectedEdge.id } })
              handleSelectEdge(null)
            }
          }}
        />
        {!selectedNode && !selectedEdge && showPreview && (
          <OrchestratorPreview
            workflow={workflow}
            onClose={() => setShowPreview(false)}
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
          onStarted={(_runId) => {
            setShowRunModal(false)
            navigate(`/w/${workflowId}/runs`)
          }}
          onClose={() => setShowRunModal(false)}
          onExport={() => setShowExport(true)}
        />
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} initialTab={helpTab} />}
    </div>
  )
}
