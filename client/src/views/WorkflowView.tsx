import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Navigate, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'
import { useWorkflow } from '../hooks/useWorkflow.ts'
import { useAutoSave } from '../hooks/useAutoSave.ts'
import { useRunEvents } from '../hooks/useRunEvents.ts'
import { slugify } from '../../../src/slugify.ts'
import { validateWorkflow } from '../lib/validation.ts'
import { RunModal } from '../components/RunModal.tsx'
import { ExportFlow } from '../components/ExportFlow.tsx'
import { HelpModal } from '../components/HelpModal.tsx'
import { RunsMode } from './modes/RunsMode.tsx'
import { AutomateMode } from './modes/AutomateMode.tsx'
import { WorkflowHeader } from '../components/shell/WorkflowHeader.tsx'
import { BuildMode } from './modes/BuildMode.tsx'
import './WorkflowView.css'

type Mode = 'build' | 'runs' | 'automate'
const VALID_MODES: Mode[] = ['build', 'runs', 'automate']

export function WorkflowView() {
  const { id, mode: rawMode } = useParams<{ id: string; mode: string }>()
  const navigate = useNavigate()
  // Validate mode early — unknown modes redirect to build
  const mode = VALID_MODES.includes(rawMode as Mode) ? (rawMode as Mode) : null

  const [filePath, setFilePath] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState<Error | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  // ── Lifted UI state (previously owned by BuildMode) ──────────────────────
  const [showRunModal, setShowRunModal] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  // Validation popover open state + refs
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

  const { workflow, dispatch, canUndo, canRedo } = useWorkflow()
  const { isSaving, isDirty, flush } = useAutoSave(workflow, filePath, {
    onError: (err) => setSaveError(err),
    onSuccess: () => setSaveError(null),
  })
  const runState = useRunEvents(workflow.meta.id || id || '')
  const workflowSlug = 'cwc-' + slugify(workflow.meta.name)

  // Resolve id → file path on mount or when id changes
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)

    api.workflows.list()
      .then(async (items) => {
        const item = items.find((w) => w.id === id)
        if (!item) {
          if (!cancelled) { setNotFound(true); setLoading(false) }
          return
        }
        const cwc = await api.workflows.read(item.path)
        if (cancelled) return
        setFilePath(item.path)
        dispatch({ type: 'LOAD', payload: cwc })
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setNotFound(true); setLoading(false) } })

    return () => { cancelled = true }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  // dispatch is stable (useReducer); omitting from deps is intentional

  const handleRename = useCallback(async (newName: string) => {
    if (!filePath) return
    setRenameError(null)
    try {
      await flush()
      const result = await api.workflows.rename(filePath, newName)
      if (result.renamed) setFilePath(result.path)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    }
  }, [filePath, flush])

  // ── Derived values ────────────────────────────────────────────────────────
  const validation = validateWorkflow(workflow)
  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  const selectedNode = selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? workflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const helpTab = selectedNode ? 'nodes' : selectedEdge ? 'edges' : undefined

  // Derive node run states from live run events for canvas pulse animation
  const nodeRunStates: Record<string, 'active' | 'done'> = {}
  if (runState.activeRun) {
    for (const e of runState.liveEvents) {
      if (e.type === 'step_started' && e.nodeId) nodeRunStates[e.nodeId] = 'active'
      if (e.type === 'step_completed' && e.nodeId) nodeRunStates[e.nodeId] = 'done'
    }
  }

  const handleSelectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId)
    if (nodeId) setSelectedEdgeId(null)
  }, [])

  const handleSelectEdge = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId)
    if (edgeId) setSelectedNodeId(null)
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

  function nodeNameFor(nodeId: string | undefined) {
    if (!nodeId) return null
    const node = workflow.nodes.find((n) => n.id === nodeId)
    return node?.agent.name?.trim() || 'Untitled agent'
  }

  // ── Per-mode action buttons ───────────────────────────────────────────────

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
        {runState.activeRun !== null ? 'Running...' : 'Test run'}
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

  const runsActions = (
    <button
      className="workflow-view__action-btn"
      onClick={() => setShowRunModal(true)}
      type="button"
      title="Run this workflow headlessly"
    >
      {runState.activeRun !== null ? 'Running...' : 'Test run'}
    </button>
  )

  // ── Early returns for loading / not found ────────────────────────────────

  // Invalid mode → redirect to build
  if (!mode) {
    return <Navigate to={`/w/${id}/build`} replace />
  }

  if (loading) {
    return (
      <div className="workflow-view__loading">
        Loading…
      </div>
    )
  }

  if (notFound || !id) {
    return <Navigate to="/" replace />
  }

  // ── Shared header props ───────────────────────────────────────────────────

  const headerProps = {
    workflow,
    dispatch,
    workflowId: id,
    pausedCount: runState.pausedRuns.length,
    isSaving,
    saveError,
    renameError,
    isDirty,
    onRename: handleRename,
    onDismissSaveError: () => setSaveError(null),
  }

  const modeProps = {
    workflow,
    dispatch,
    runState,
    workflowSlug,
    workflowPath: filePath ?? '',
  }

  const modeActions =
    mode === 'build' ? buildActions :
    mode === 'runs' ? runsActions :
    null

  return (
    <div className="workflow-view">
      {/* Header rendered ONCE — stable across all mode switches */}
      <WorkflowHeader
        {...headerProps}
        activeMode={mode}
        actions={modeActions}
      />

      {/* Body swaps per mode; header above is never remounted */}
      <div className="workflow-view__body">
        {mode === 'build' && (
          <BuildMode
            {...modeProps}
            workflowId={id}
            validation={validation}
            nodeRunStates={nodeRunStates}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            showPreview={showPreview}
            onClosePreview={() => setShowPreview(false)}
          />
        )}
        {mode === 'runs' && <RunsMode {...modeProps} />}
        {mode === 'automate' && <AutomateMode {...modeProps} />}
      </div>

      {/* Shared overlays driven by lifted state */}
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
            if (mode === 'build') navigate(`/w/${id}/runs`)
          }}
          onClose={() => setShowRunModal(false)}
          onExport={mode === 'build' ? () => setShowExport(true) : undefined}
        />
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} initialTab={helpTab} />}
    </div>
  )
}
