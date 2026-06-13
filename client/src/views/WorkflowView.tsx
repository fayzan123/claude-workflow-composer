import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Navigate, useNavigate } from 'react-router-dom'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'
import { useWorkflow } from '../hooks/useWorkflow.ts'
import { useAutoSave } from '../hooks/useAutoSave.ts'
import { useRunEvents } from '../hooks/useRunEvents.ts'
import { slugify } from '../../../src/slugify.ts'
import { RunPanel } from '../components/RunPanel.tsx'
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
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

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

  function handleHome() {
    if (isDirty) {
      setShowLeaveConfirm(true)
    } else {
      navigate('/')
    }
  }

  function handleLeaveConfirm() {
    setShowLeaveConfirm(false)
    navigate('/')
  }

  function handleLeaveCancel() {
    setShowLeaveConfirm(false)
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

  const buildProps = {
    ...modeProps,
    isSaving,
    saveError,
    renameError,
    isDirty,
    canUndo,
    canRedo,
    onRename: handleRename,
    onDismissSaveError: () => setSaveError(null),
    onHome: handleHome,
    onLeaveConfirm: handleLeaveConfirm,
    onLeaveCancel: handleLeaveCancel,
    showLeaveConfirm,
  }

  if (mode === 'build') {
    return (
      <div className="workflow-view">
        <BuildMode {...buildProps} />
      </div>
    )
  }

  if (mode === 'runs') {
    return (
      <div className="workflow-view workflow-view--runs">
        <div className="workflow-view__mode-header">
          <button
            className="workflow-view__back-btn"
            onClick={handleHome}
            type="button"
            title="Back to home"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
          <span className="workflow-view__title">{workflow.meta.name}</span>
          <nav className="workflow-view__mode-tabs">
            <button
              className="workflow-view__mode-tab"
              onClick={() => navigate(`/w/${id}/build`)}
              type="button"
            >
              Build
            </button>
            <button
              className="workflow-view__mode-tab workflow-view__mode-tab--active"
              type="button"
            >
              Runs {runState.pausedRuns.length > 0 ? `(⏸ ${runState.pausedRuns.length})` : ''}
            </button>
            <button
              className="workflow-view__mode-tab"
              onClick={() => navigate(`/w/${id}/automate`)}
              type="button"
            >
              Automate
            </button>
          </nav>
        </div>
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
      </div>
    )
  }

  // automate mode
  const triggers = workflow.meta.triggers ?? []
  return (
    <div className="workflow-view workflow-view--automate">
      <div className="workflow-view__mode-header">
        <button
          className="workflow-view__back-btn"
          onClick={handleHome}
          type="button"
          title="Back to home"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>
        <span className="workflow-view__title">{workflow.meta.name}</span>
        <nav className="workflow-view__mode-tabs">
          <button
            className="workflow-view__mode-tab"
            onClick={() => navigate(`/w/${id}/build`)}
            type="button"
          >
            Build
          </button>
          <button
            className="workflow-view__mode-tab"
            onClick={() => navigate(`/w/${id}/runs`)}
            type="button"
          >
            Runs
          </button>
          <button
            className="workflow-view__mode-tab workflow-view__mode-tab--active"
            type="button"
          >
            Automate
          </button>
        </nav>
      </div>
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
