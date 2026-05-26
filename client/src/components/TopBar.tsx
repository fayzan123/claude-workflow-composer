import React, { useState, useRef, useEffect } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ValidationResult } from '../lib/validation.ts'
import './TopBar.css'

interface Props {
  workflow: CwcFile
  validation: ValidationResult
  isSaving: boolean
  dispatch: React.Dispatch<WorkflowAction>
  onExport: () => void
  onHome: () => void
}

export function TopBar({ workflow, validation, isSaving, dispatch, onExport, onHome }: Props) {
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
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setErrorsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [errorsOpen])

  useEffect(() => {
    if (!warningsOpen) return
    function handleClick(e: MouseEvent) {
      if (!warningsPopoverRef.current?.contains(e.target as Node) && !warningsBadgeRef.current?.contains(e.target as Node)) {
        setWarningsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setWarningsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [warningsOpen])

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'SET_META', payload: { name: e.target.value } })
  }

  function nodeNameFor(nodeId: string | undefined) {
    if (!nodeId) return null
    const node = workflow.nodes.find((n) => n.id === nodeId)
    return node?.agent.name?.trim() || 'Untitled agent'
  }

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  return (
    <header className="top-bar">
      <button className="top-bar__home-btn" onClick={onHome} type="button" title="Back to home">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>

      <div className="top-bar__name-wrap">
        <input
          className="top-bar__name-input"
          type="text"
          value={workflow.meta.name}
          onChange={handleNameChange}
          aria-label="Workflow name"
          placeholder="Workflow name"
        />
        <div className="top-bar__meta">
          {workflow.nodes.length} agent{workflow.nodes.length !== 1 ? 's' : ''}
          {workflow.edges.length > 0 && ` · ${workflow.edges.length} handoff${workflow.edges.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      <div className="top-bar__status">
        <span className={`top-bar__save-indicator ${isSaving ? 'top-bar__save-indicator--saving' : 'top-bar__save-indicator--saved'}`}>
          <span className="top-bar__save-dot" />
          {isSaving ? 'Saving' : 'Saved'}
        </span>

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
                      {err.nodeId && (
                        <span className="top-bar__popover-node">{nodeNameFor(err.nodeId)}</span>
                      )}
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
                      {w.nodeId && (
                        <span className="top-bar__popover-node">{nodeNameFor(w.nodeId)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

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
