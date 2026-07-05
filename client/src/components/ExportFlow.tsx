import React, { useState, useEffect, useRef } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ExportTarget, ExportResult } from '../../../src/export/exporter.ts'
import type { DeleteExportResult } from '../../../src/server/api/export-delete.ts'
import { workflowSkillSlug } from '../../../src/slugify.ts'
import { api } from '../lib/api.ts'
import { toast } from '../lib/toast.ts'
import { FieldHint } from './common/FieldHint.tsx'
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
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

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
      if (res.updatedCwc.meta.exportedWorkflowSlug) {
        dispatch({ type: 'SET_EXPORTED_WORKFLOW_SLUG', payload: { slug: res.updatedCwc.meta.exportedWorkflowSlug } })
      }
      setResult(res)
      setStep('result')
      toast.success('Workflow exported', `/${workflowSkillSlug(res.updatedCwc.meta.name)} is ready in Claude Code`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
      toast.error('Export failed', err instanceof Error ? err.message : 'Could not export workflow')
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
      toast.success('Export deleted', `${res.deleted.length} file${res.deleted.length !== 1 ? 's' : ''} removed`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      toast.error('Delete export failed', err instanceof Error ? err.message : 'Could not delete export')
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
            <FieldHint id="export.target" />

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

            <label className="export-flow__obs-toggle">
              <input
                type="checkbox"
                checked={workflow.meta.observability?.enabled !== false}
                onChange={(e) =>
                  dispatch({ type: 'SET_META', payload: { observability: { enabled: e.target.checked } } })
                }
              />
              Report run progress to CWC (adds run logging to the exported skill)
            </label>
            <FieldHint id="export.observability" />

            <label className="export-flow__obs-toggle export-flow__invoke-toggle">
              <input
                type="checkbox"
                checked={workflow.meta.modelInvocation === 'auto'}
                onChange={(e) =>
                  dispatch({ type: 'SET_META', payload: { modelInvocation: e.target.checked ? 'auto' : 'off' } })
                }
              />
              Allow Claude to run this workflow automatically
            </label>
            <FieldHint id="export.modelInvocation" />
            {workflow.meta.modelInvocation === 'auto' && (
              <p className="export-flow__invoke-warning" role="status">
                Autonomous invocation bypasses CWC's test-run launcher: no worktree
                isolation, no stop button, and no guaranteed run history.
              </p>
            )}

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

        {step === 'result' && result && (() => {
          const invokeCmd = `/${workflowSkillSlug(result.updatedCwc.meta.name)}`
          return (
          <div className="export-flow-step">
            <div className="export-flow-success-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="export-flow-modal__title">Export complete!</h2>
            <p className="export-flow-modal__subtitle">Workflow written to disk successfully.</p>

            <div className="export-flow-invoke">
              <p className="export-flow-invoke__label">Invoke in Claude Code</p>
              <div className="export-flow-invoke__row">
                <code className="export-flow-invoke__cmd">{invokeCmd}</code>
                <button
                  className="export-flow-invoke__copy"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(invokeCmd).then(() => {
                      setCopied(true)
                      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
                      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
                    })
                  }}
                  aria-label="Copy command"
                >
                  {copied ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

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
        )})()}

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
