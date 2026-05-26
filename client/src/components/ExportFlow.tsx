import React, { useState } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ExportTarget, ExportResult } from '../../../src/exporter.ts'
import { api } from '../lib/api.ts'
import './ExportFlow.css'

interface Props {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
  projectDir?: string
}

type Step = 'target-select' | 'previewing' | 'confirming' | 'result'

interface PreviewData {
  files: { path: string; content: string }[]
  warnings: string[]
  target: ExportTarget
}

export function ExportFlow({ workflow, dispatch, onClose, projectDir }: Props) {
  const [step, setStep] = useState<Step>('target-select')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingPhase, setLoadingPhase] = useState<'preview' | 'export'>('preview')

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
    if (!projectDir) {
      setError('No project directory available. Save the workflow to a project first.')
      return
    }
    runPreview({ type: 'project', projectDir })
  }

  function shortenPath(filePath: string): string {
    const home = filePath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
    return home
  }

  return (
    <div className="export-flow-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="export-flow-modal" role="dialog" aria-modal="true" aria-label="Export workflow">
        <button className="export-flow-modal__close" onClick={onClose} type="button" aria-label="Close">
          ✕
        </button>

        {step === 'target-select' && (
          <div className="export-flow-step">
            <h2 className="export-flow-modal__title">Export Workflow</h2>
            <p className="export-flow-modal__subtitle">Choose where to export your workflow agents.</p>

            {error && (
              <div className="export-flow-error">
                <span>{error}</span>
              </div>
            )}

            <div className="export-flow-targets">
              <button
                className="export-flow-target-btn"
                onClick={handleUserExport}
                type="button"
              >
                <span className="export-flow-target-btn__icon">~</span>
                <span className="export-flow-target-btn__label">User</span>
                <span className="export-flow-target-btn__path">~/.claude/</span>
              </button>

              <button
                className="export-flow-target-btn"
                onClick={handleProjectExport}
                disabled={!projectDir}
                type="button"
                title={!projectDir ? 'Save the workflow to a project directory first' : undefined}
              >
                <span className="export-flow-target-btn__icon">.</span>
                <span className="export-flow-target-btn__label">Project</span>
                <span className="export-flow-target-btn__path">.claude/</span>
              </button>
            </div>
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
              {preview.files.length} file{preview.files.length !== 1 ? 's' : ''} will be written.
            </p>

            {error && (
              <div className="export-flow-error">
                <span>{error}</span>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="export-flow-warnings">
                <p className="export-flow-warnings__label">Warnings:</p>
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
                  <summary className="export-flow-preview-file__path">{shortenPath(f.path)}</summary>
                  <pre className="export-flow-preview-file__content">
                    {f.content.split('\n').slice(0, 20).join('\n')}
                    {f.content.split('\n').length > 20 ? '\n…' : ''}
                  </pre>
                </details>
              ))}
            </div>

            <div className="export-flow-actions">
              <button
                className="export-flow-back-btn"
                onClick={() => { setError(null); setStep('target-select') }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="export-flow-confirm-btn"
                onClick={runExport}
                type="button"
              >
                Confirm Export
              </button>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div className="export-flow-step">
            <div className="export-flow-success-icon" aria-hidden="true">✓</div>
            <h2 className="export-flow-modal__title">Export complete!</h2>

            {result.warnings.length > 0 && (
              <div className="export-flow-warnings">
                <p className="export-flow-warnings__label">Warnings:</p>
                <ul className="export-flow-warnings__list">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              className="export-flow-close-btn"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
