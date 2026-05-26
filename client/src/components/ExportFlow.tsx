import React, { useState } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ExportTarget, ExportResult } from '../../../src/exporter.ts'
import type { DeleteExportResult } from '../../../src/server/api/export-delete.ts'
import { api } from '../lib/api.ts'
import './ExportFlow.css'

interface Props {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
}

type Step = 'target-select' | 'previewing' | 'confirming' | 'result' | 'delete-target' | 'deleting' | 'delete-result'

interface PreviewData {
  files: { path: string; content: string }[]
  warnings: string[]
  target: ExportTarget
}

export function ExportFlow({ workflow, dispatch, onClose }: Props) {
  const [step, setStep] = useState<Step>('target-select')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingPhase, setLoadingPhase] = useState<'preview' | 'export'>('preview')
  const [deleteResult, setDeleteResult] = useState<DeleteExportResult | null>(null)
  const [projectDir, setProjectDir] = useState(() => localStorage.getItem('cwc:lastProjectDir') ?? '')

  const hasBeenExported = workflow.nodes.some((n) => n.exportedSlug)

  async function runPreview(target: ExportTarget) {
    setLoadingPhase('preview')
    setStep('previewing')
    setError(null)
    try {
      const res = await api.exportPreview(workflow, target)
      setPreview({ ...res, target })
      setStep('confirming')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
      setStep('target-select')
    }
  }

  async function runExport() {
    if (!preview) return
    setLoadingPhase('export')
    setStep('previewing')
    setError(null)
    try {
      const res = await api.export(workflow, preview.target)
      for (const node of res.updatedCwc.nodes) {
        if (node.exportedSlug) {
          dispatch({ type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId: node.id, slug: node.exportedSlug } })
        }
      }
      setResult(res)
      setStep('result')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
      setStep('confirming')
    }
  }

  function handleUserExport() {
    runPreview({ type: 'user' })
  }

  function handleProjectExport() {
    localStorage.setItem('cwc:lastProjectDir', projectDir)
    runPreview({ type: 'project', projectDir })
  }

  async function runDelete(target: ExportTarget) {
    setStep('deleting')
    setError(null)
    try {
      const res = await api.deleteExport(workflow, target)
      setDeleteResult(res)
      setStep('delete-result')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setStep('delete-target')
    }
  }

  function shortenPath(filePath: string): string {
    return filePath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  }

  return (
    <div className="export-flow-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="export-flow-modal" role="dialog" aria-modal="true" aria-label="Export workflow">
        <button className="export-flow-modal__close" onClick={onClose} type="button" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {step === 'target-select' && (
          <div className="export-flow-step">
            <h2 className="export-flow-modal__title">Export Workflow</h2>
            <p className="export-flow-modal__subtitle">Choose where to export your workflow agents.</p>

            {error && (
              <div className="export-flow-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div className="export-flow-targets">
              <button className="export-flow-target-btn" onClick={handleUserExport} type="button">
                <span className="export-flow-target-btn__icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </span>
                <span className="export-flow-target-btn__label">User</span>
                <span className="export-flow-target-btn__path">~/.claude/</span>
              </button>

              <div className="export-flow-project-input">
                <label className="export-flow-project-input__label" htmlFor="project-dir-input">
                  Project directory
                </label>
                <input
                  id="project-dir-input"
                  className="export-flow-project-input__field"
                  type="text"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="/absolute/path/to/project"
                  spellCheck={false}
                />
                <button
                  className="export-flow-target-btn"
                  onClick={handleProjectExport}
                  disabled={!projectDir.startsWith('/')}
                  type="button"
                  title={!projectDir.startsWith('/') ? 'Enter an absolute path starting with /' : undefined}
                >
                  <span className="export-flow-target-btn__icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </span>
                  <span className="export-flow-target-btn__label">Project</span>
                  <span className="export-flow-target-btn__path">
                    {projectDir ? shortenPath(projectDir) + '/' : '.claude/'}
                  </span>
                </button>
              </div>
            </div>

            {hasBeenExported && (
              <div className="export-flow-danger-zone">
                <p className="export-flow-danger-zone__label">Danger Zone</p>
                <p className="export-flow-danger-zone__desc">Remove exported agents and workflow skill from disk. Only files owned by this workflow will be deleted.</p>
                <button className="export-flow-delete-link" onClick={() => { setError(null); setStep('delete-target') }} type="button">
                  Delete export…
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'previewing' && (
          <div className="export-flow-step export-flow-step--centered">
            <div className="export-flow-spinner" aria-hidden="true" />
            <p className="export-flow-modal__subtitle">{loadingPhase === 'export' ? 'Exporting…' : 'Loading preview…'}</p>
          </div>
        )}

        {step === 'confirming' && preview && (
          <div className="export-flow-step">
            <h2 className="export-flow-modal__title">Preview Export</h2>
            <p className="export-flow-modal__subtitle">
              {preview.files.length} file{preview.files.length !== 1 ? 's' : ''} will be written
              to <code className="export-flow-dir">{preview.target.type === 'user' ? '~/.claude/' : shortenPath(preview.target.projectDir + '/.claude/')}</code>
            </p>

            {error && (
              <div className="export-flow-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="export-flow-warnings">
                <p className="export-flow-warnings__label">Warnings</p>
                <ul className="export-flow-warnings__list">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="export-flow-preview-files">
              {preview.files.map((f, i) => (
                <details key={i} className="export-flow-preview-file">
                  <summary className="export-flow-preview-file__path">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    {shortenPath(f.path)}
                  </summary>
                  <pre className="export-flow-preview-file__content">
                    {f.content.split('\n').slice(0, 20).join('\n')}
                    {f.content.split('\n').length > 20 ? '\n…' : ''}
                  </pre>
                </details>
              ))}
            </div>

            <div className="export-flow-actions">
              <button className="export-flow-back-btn" onClick={() => { setError(null); setStep('target-select') }} type="button">
                Cancel
              </button>
              <button className="export-flow-confirm-btn" onClick={runExport} type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Confirm Export
              </button>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div className="export-flow-step">
            <div className="export-flow-success-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="export-flow-modal__title">Export complete!</h2>
            <p className="export-flow-modal__subtitle">Workflow written to disk successfully.</p>

            {result.warnings.length > 0 && (
              <div className="export-flow-warnings">
                <p className="export-flow-warnings__label">Warnings</p>
                <ul className="export-flow-warnings__list">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <button className="export-flow-close-btn" onClick={onClose} type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Close
            </button>
          </div>
        )}

        {step === 'delete-target' && (
          <div className="export-flow-step">
            <h2 className="export-flow-modal__title">Delete Export</h2>
            <p className="export-flow-modal__subtitle">Choose where to delete from. Only files owned by this workflow will be removed.</p>

            {error && (
              <div className="export-flow-error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div className="export-flow-targets">
              <button className="export-flow-target-btn export-flow-target-btn--danger" onClick={() => runDelete({ type: 'user' })} type="button">
                <span className="export-flow-target-btn__icon export-flow-target-btn__icon--danger">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </span>
                <span className="export-flow-target-btn__label">User</span>
                <span className="export-flow-target-btn__path">~/.claude/</span>
              </button>

              <button
                className="export-flow-target-btn export-flow-target-btn--danger"
                onClick={() => runDelete({ type: 'project', projectDir })}
                disabled={!projectDir.startsWith('/')}
                type="button"
                title={!projectDir.startsWith('/') ? 'Enter an absolute path starting with /' : undefined}
              >
                <span className="export-flow-target-btn__icon export-flow-target-btn__icon--danger">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <span className="export-flow-target-btn__label">Project</span>
                <span className="export-flow-target-btn__path">
                  {projectDir ? shortenPath(projectDir) + '/' : '.claude/'}
                </span>
              </button>
            </div>

            <div className="export-flow-actions">
              <button className="export-flow-back-btn" onClick={() => { setError(null); setStep('target-select') }} type="button">
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === 'deleting' && (
          <div className="export-flow-step export-flow-step--centered">
            <div className="export-flow-spinner" aria-hidden="true" />
            <p className="export-flow-modal__subtitle">Deleting export…</p>
          </div>
        )}

        {step === 'delete-result' && deleteResult && (
          <div className="export-flow-step">
            <div className="export-flow-success-icon export-flow-success-icon--neutral" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
              </svg>
            </div>
            <h2 className="export-flow-modal__title">Export deleted</h2>
            <p className="export-flow-modal__subtitle">{deleteResult.deleted.length} file{deleteResult.deleted.length !== 1 ? 's' : ''} removed.</p>

            {deleteResult.deleted.length > 0 && (
              <div className="export-flow-delete-list">
                <p className="export-flow-delete-list__label">Deleted</p>
                <ul className="export-flow-delete-list__items">
                  {deleteResult.deleted.map((f, i) => <li key={i}>{shortenPath(f)}</li>)}
                </ul>
              </div>
            )}

            {deleteResult.skipped.length > 0 && (
              <div className="export-flow-warnings">
                <p className="export-flow-warnings__label">Skipped (not owned by this workflow)</p>
                <ul className="export-flow-warnings__list">
                  {deleteResult.skipped.map((f, i) => <li key={i}>{shortenPath(f)}</li>)}
                </ul>
              </div>
            )}

            <button className="export-flow-close-btn" onClick={onClose} type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
