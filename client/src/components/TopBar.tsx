import React from 'react'
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
  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'SET_META', payload: { name: e.target.value } })
  }

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  return (
    <header className="top-bar">
      <button className="top-bar__home-btn" onClick={onHome} type="button">
        ← Home
      </button>

      <input
        className="top-bar__name-input"
        type="text"
        value={workflow.meta.name}
        onChange={handleNameChange}
        aria-label="Workflow name"
        placeholder="Workflow name"
      />

      <div className="top-bar__status">
        <span className={`top-bar__save-indicator ${isSaving ? 'top-bar__save-indicator--saving' : 'top-bar__save-indicator--saved'}`}>
          {isSaving ? 'Saving…' : 'Saved'}
        </span>

        {hasErrors && (
          <span className="top-bar__badge top-bar__badge--error" title={validation.errors.map((e) => e.message).join('\n')}>
            ✕ {validation.errors.length} {validation.errors.length === 1 ? 'error' : 'errors'}
          </span>
        )}

        {!hasErrors && hasWarnings && (
          <span className="top-bar__badge top-bar__badge--warning" title={validation.warnings.map((w) => w.message).join('\n')}>
            ⚠ {validation.warnings.length} {validation.warnings.length === 1 ? 'warning' : 'warnings'}
          </span>
        )}

        <button
          className="top-bar__export-btn"
          onClick={onExport}
          disabled={!validation.canExport}
          type="button"
        >
          Export
        </button>
      </div>
    </header>
  )
}
