import React from 'react'
import { useNavigate } from 'react-router-dom'
import type { CwcFile } from '../../types.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import { ThemeToggle } from '../common/ThemeToggle.tsx'
import { ModeSwitcher } from './ModeSwitcher.tsx'
import './WorkflowHeader.css'

interface Props {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  workflowId: string
  activeMode: 'build' | 'runs' | 'automate'
  pausedCount: number
  isSaving: boolean
  saveError: Error | null
  renameError: string | null
  isDirty: boolean
  onRename: (newName: string) => void
  onDismissSaveError: () => void
  /** Action slot rendered on the right side — mode-specific buttons injected by the view */
  actions?: React.ReactNode
}

export function WorkflowHeader({
  workflow,
  dispatch,
  workflowId,
  activeMode,
  pausedCount,
  isSaving,
  saveError,
  renameError,
  isDirty,
  onRename,
  onDismissSaveError,
  actions,
}: Props) {
  const navigate = useNavigate()
  const [showLeaveConfirm, setShowLeaveConfirm] = React.useState(false)

  function handleHomeClick() {
    if (isDirty) {
      setShowLeaveConfirm(true)
    } else {
      navigate('/')
    }
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'SET_META', payload: { name: e.target.value } })
  }

  function handleNameBlur() {
    onRename(workflow.meta.name.trim() || 'Untitled Workflow')
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur()
  }

  if (showLeaveConfirm) {
    return (
      <header className="workflow-header">
        <div className="workflow-header__left">
          <button
            className="workflow-header__back-btn"
            onClick={handleHomeClick}
            type="button"
            title="Back to home"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
          <div className="workflow-header__name-wrap">
            <span className="workflow-header__leave-msg">Changes are still saving — leave anyway?</span>
          </div>
        </div>
        {/* Center column: keep ModeSwitcher in place so layout stays stable */}
        <ModeSwitcher id={workflowId} active={activeMode} pausedCount={pausedCount} />
        <div className="workflow-header__status">
          <button
            className="workflow-header__leave-btn workflow-header__leave-btn--confirm"
            onClick={() => { setShowLeaveConfirm(false); navigate('/') }}
            type="button"
          >
            Leave
          </button>
          <button
            className="workflow-header__leave-btn workflow-header__leave-btn--cancel"
            onClick={() => setShowLeaveConfirm(false)}
            type="button"
          >
            Stay
          </button>
        </div>
      </header>
    )
  }

  return (
    <header className="workflow-header">
      <div className="workflow-header__left">
        <button
          className="workflow-header__back-btn"
          onClick={handleHomeClick}
          type="button"
          title="Back to home"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>

        <div className="workflow-header__name-wrap">
          <input
            className="workflow-header__name-input"
            type="text"
            value={workflow.meta.name}
            onChange={handleNameChange}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            aria-label="Workflow name"
            placeholder="Workflow name"
          />
          <input
            className="workflow-header__desc-input"
            type="text"
            value={workflow.meta.description}
            onChange={(e) => dispatch({ type: 'SET_META', payload: { description: e.target.value } })}
            aria-label="Workflow description"
            placeholder="Add a description…"
          />
          {renameError && (
            <span className="workflow-header__rename-error" role="alert">{renameError}</span>
          )}
        </div>
      </div>

      <ModeSwitcher id={workflowId} active={activeMode} pausedCount={pausedCount} />

      <div className="workflow-header__status">
        {saveError ? (
          <button
            className="workflow-header__save-indicator workflow-header__save-indicator--error"
            onClick={onDismissSaveError}
            type="button"
            title="Click to dismiss"
          >
            <span className="workflow-header__save-dot" />
            Save failed
          </button>
        ) : (
          <span className={`workflow-header__save-indicator${isSaving ? ' workflow-header__save-indicator--saving' : ' workflow-header__save-indicator--saved'}`}>
            <span className="workflow-header__save-dot" />
            {isSaving ? 'Saving' : 'Saved'}
          </span>
        )}
        <ThemeToggle className="workflow-header__theme" />
        {actions}
      </div>
    </header>
  )
}
