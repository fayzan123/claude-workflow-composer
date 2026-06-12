import React, { useState, useRef, useEffect } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ValidationResult } from '../lib/validation.ts'
import './TopBar.css'

interface Props {
  workflow: CwcFile
  validation: ValidationResult
  isSaving: boolean
  saveError: Error | null
  renameError: string | null
  showLeaveConfirm: boolean
  dispatch: React.Dispatch<WorkflowAction>
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  previewOpen: boolean
  onTogglePreview: () => void
  onExport: () => void
  onHome: () => void
  onHelp: () => void
  onRename: (newName: string) => void
  onLeaveConfirm: () => void
  onLeaveCancel: () => void
  onDismissSaveError: () => void
  onTestRun: () => void
  onToggleRuns: () => void
  runActive: boolean
  pausedCount: number
}

export function TopBar({
  workflow, validation, isSaving, saveError, renameError, showLeaveConfirm,
  dispatch, canUndo, canRedo, onUndo, onRedo, previewOpen, onTogglePreview, onExport, onHome, onHelp, onRename, onLeaveConfirm, onLeaveCancel, onDismissSaveError,
  onTestRun, onToggleRuns, runActive, pausedCount,
}: Props) {
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const errorsBadgeRef = useRef<HTMLButtonElement>(null)
  const errorsPopoverRef = useRef<HTMLDivElement>(null)
  const warningsBadgeRef = useRef<HTMLButtonElement>(null)
  const warningsPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
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

  useEffect(() => {
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

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'SET_META', payload: { name: e.target.value } })
  }

  function handleNameBlur() {
    onRename(workflow.meta.name.trim() || 'Untitled Workflow')
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  function nodeNameFor(nodeId: string | undefined) {
    if (!nodeId) return null
    const node = workflow.nodes.find((n) => n.id === nodeId)
    return node?.agent.name?.trim() || 'Untitled agent'
  }

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  if (showLeaveConfirm) {
    return (
      <header className="top-bar">
        <button className="top-bar__home-btn" onClick={onHome} type="button" title="Back to home">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>
        <div className="top-bar__name-wrap">
          <span className="top-bar__leave-msg">Changes are still saving — leave anyway?</span>
        </div>
        <div className="top-bar__status">
          <button className="top-bar__leave-btn top-bar__leave-btn--confirm" onClick={onLeaveConfirm} type="button">Leave</button>
          <button className="top-bar__leave-btn top-bar__leave-btn--cancel" onClick={onLeaveCancel} type="button">Stay</button>
        </div>
      </header>
    )
  }

  return (
    <header className="top-bar">
      <button className="top-bar__home-btn" onClick={onHome} type="button" title="Back to home">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>

      <div className="top-bar__history">
        <button
          className="top-bar__history-btn"
          onClick={onUndo}
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
          className="top-bar__history-btn"
          onClick={onRedo}
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
      </div>

      <div className="top-bar__name-wrap">
        <input
          className="top-bar__name-input"
          type="text"
          value={workflow.meta.name}
          onChange={handleNameChange}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          aria-label="Workflow name"
          placeholder="Workflow name"
        />
        <input
          className="top-bar__desc-input"
          type="text"
          value={workflow.meta.description}
          onChange={(e) => dispatch({ type: 'SET_META', payload: { description: e.target.value } })}
          aria-label="Workflow description"
          placeholder="Add a description…"
        />
        <div className="top-bar__meta">
          {workflow.nodes.length} agent{workflow.nodes.length !== 1 ? 's' : ''}
          {workflow.edges.length > 0 && ` · ${workflow.edges.length} handoff${workflow.edges.length !== 1 ? 's' : ''}`}
        </div>
        {renameError && (
          <div className="top-bar__rename-error" role="alert">{renameError}</div>
        )}
      </div>

      <div className="top-bar__status">
        {saveError ? (
          <button
            className="top-bar__save-indicator top-bar__save-indicator--error"
            onClick={onDismissSaveError}
            type="button"
            title="Click to dismiss"
          >
            <span className="top-bar__save-dot" />
            Save failed
          </button>
        ) : (
          <span className={`top-bar__save-indicator ${isSaving ? 'top-bar__save-indicator--saving' : 'top-bar__save-indicator--saved'}`}>
            <span className="top-bar__save-dot" />
            {isSaving ? 'Saving' : 'Saved'}
          </span>
        )}

        {hasErrors && (
          <div className="top-bar__badge-wrap">
            <button
              ref={errorsBadgeRef}
              className="top-bar__badge top-bar__badge--error"
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
              <div ref={errorsPopoverRef} className="top-bar__popover top-bar__popover--error" role="dialog" aria-label="Workflow errors">
                <p className="top-bar__popover-heading">Fix before exporting</p>
                <ul className="top-bar__popover-list">
                  {validation.errors.map((err, i) => (
                    <li key={i} className="top-bar__popover-item">
                      <span className="top-bar__popover-msg">{err.message}</span>
                      {err.nodeId && <span className="top-bar__popover-node">{nodeNameFor(err.nodeId)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!hasErrors && hasWarnings && (
          <div className="top-bar__badge-wrap">
            <button
              ref={warningsBadgeRef}
              className="top-bar__badge top-bar__badge--warning"
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
              <div ref={warningsPopoverRef} className="top-bar__popover top-bar__popover--warning" role="dialog" aria-label="Workflow warnings">
                <p className="top-bar__popover-heading">Warnings</p>
                <ul className="top-bar__popover-list">
                  {validation.warnings.map((w, i) => (
                    <li key={i} className="top-bar__popover-item">
                      <span className="top-bar__popover-msg">{w.message}</span>
                      {w.nodeId && <span className="top-bar__popover-node">{nodeNameFor(w.nodeId)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <button
          className="top-bar__help-btn"
          onClick={onHelp}
          type="button"
          title="Help"
          aria-label="Help"
        >
          ?
        </button>

        <button
          className={`top-bar__preview-btn ${previewOpen ? 'top-bar__preview-btn--active' : ''}`}
          onClick={onTogglePreview}
          type="button"
          title="Toggle orchestrator preview"
          aria-pressed={previewOpen}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Preview
        </button>

        <button
          className={`top-bar__preview-btn ${runActive ? 'top-bar__preview-btn--active' : ''}`}
          onClick={onTestRun}
          type="button"
          title="Run this workflow headlessly"
        >
          {runActive ? '● Running…' : '▶ Test Run'}
        </button>

        <button
          className={`top-bar__preview-btn${pausedCount > 0 ? ' top-bar__preview-btn--attention' : ''}`}
          onClick={onToggleRuns}
          type="button"
          title="Run history"
        >
          {`Runs${pausedCount > 0 ? ` (${pausedCount})` : ''}`}
        </button>

        <button
          className="top-bar__export-btn"
          onClick={onExport}
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
      </div>
    </header>
  )
}
