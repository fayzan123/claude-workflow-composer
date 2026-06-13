import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Navigate, useNavigate } from 'react-router-dom'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'
import { useWorkflow } from '../hooks/useWorkflow.ts'
import { useAutoSave } from '../hooks/useAutoSave.ts'
import { useRunEvents } from '../hooks/useRunEvents.ts'
import { slugify } from '../../../src/slugify.ts'
import { RunPanel } from '../components/RunPanel.tsx'
import { RunModal } from '../components/RunModal.tsx'
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
  const [showRunModal, setShowRunModal] = useState(false)

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
    setLoading(true)
    setNotFound(false)

    api.workflows.list()
      .then(async (items) => {
        const item = items.find((w) => w.id === id)
        if (!item) { setNotFound(true); setLoading(false); return }
        const cwc = await api.workflows.read(item.path)
        setFilePath(item.path)
        dispatch({ type: 'LOAD', payload: cwc })
        setLoading(false)
      })
      .catch(() => { setNotFound(true); setLoading(false) })
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

  // Shared props passed into WorkflowHeader for Runs and Automate modes
  // (BuildMode composes its own WorkflowHeader internally so it can inject build actions)
  const sharedHeaderProps = {
    workflow,
    dispatch,
    workflowId: id!,
    pausedCount: runState.pausedRuns.length,
    isSaving,
    saveError,
    renameError,
    isDirty,
    onRename: handleRename,
    onDismissSaveError: () => setSaveError(null),
  }

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

  const modeProps = {
    workflow,
    dispatch,
    runState,
    workflowSlug,
    workflowPath: filePath ?? '',
  }

  if (mode === 'build') {
    return (
      <div className="workflow-view">
        <BuildMode
          {...modeProps}
          workflowId={id}
          isSaving={isSaving}
          saveError={saveError}
          renameError={renameError}
          isDirty={isDirty}
          canUndo={canUndo}
          canRedo={canRedo}
          onRename={handleRename}
          onDismissSaveError={() => setSaveError(null)}
        />
      </div>
    )
  }

  if (mode === 'runs') {
    return (
      <div className="workflow-view workflow-view--runs">
        <WorkflowHeader
          {...sharedHeaderProps}
          activeMode="runs"
          actions={
            <button
              className="workflow-view__action-btn"
              onClick={() => setShowRunModal(true)}
              type="button"
              title="Run this workflow headlessly"
            >
              {runState.activeRun !== null ? '● Running…' : '▶ Test Run'}
            </button>
          }
        />
        <div className="workflow-view__runs-body">
          <RunPanel
            workflowId={workflow.meta.id}
            runs={runState.runs}
            liveEvents={runState.liveEvents}
            activeRun={runState.activeRun}
            pausedRuns={runState.pausedRuns}
            onClose={() => navigate(`/w/${id}/build`)}
            onChanged={runState.refresh}
          />
        </div>
        {showRunModal && (
          <RunModal
            workflowId={workflow.meta.id}
            workflowSlug={workflowSlug}
            onStarted={(_runId) => setShowRunModal(false)}
            onClose={() => setShowRunModal(false)}
          />
        )}
      </div>
    )
  }

  // automate mode
  const triggers = workflow.meta.triggers ?? []
  return (
    <div className="workflow-view workflow-view--automate">
      <WorkflowHeader
        {...sharedHeaderProps}
        activeMode="automate"
        actions={null}
      />
      <div className="workflow-view__automate-body">
        {triggers.length === 0 ? (
          <div className="workflow-view__automate-empty">
            <p className="workflow-view__automate-empty-text">No automations yet.</p>
            <p className="workflow-view__automate-empty-hint">
              Edit triggers in the entry node for now — a dedicated editor is coming.
            </p>
          </div>
        ) : (
          <ul className="workflow-view__trigger-list">
            {triggers.map((trigger, i) => (
              <li key={i} className="workflow-view__trigger-item">
                <span className="workflow-view__trigger-type">{trigger.type}</span>
                {trigger.type === 'cron' && trigger.schedule && (
                  <span className="workflow-view__trigger-detail">{trigger.schedule}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="workflow-view__automate-note">
          Edit triggers in the entry node for now — a dedicated editor is coming.
        </p>
      </div>
    </div>
  )
}
