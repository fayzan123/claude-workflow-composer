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

type Step = 'target-select' | 'exporting' | 'result'

export function ExportFlow({ workflow, dispatch, onClose, projectDir }: Props) {
  const [step, setStep] = useState<Step>('target-select')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runExport(target: ExportTarget) {
    setStep('exporting')
    setError(null)
    try {
      const res = await api.export(workflow, target)
      // Dispatch slug updates for all nodes that now have an exportedSlug
      for (const node of res.updatedCwc.nodes) {
        if (node.exportedSlug) {
          dispatch({ type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId: node.id, slug: node.exportedSlug } })
        }
      }
      setResult(res)
      setStep('result')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
      setStep('target-select')
    }
  }

  function handleUserExport() {
    runExport({ type: 'user' })
  }

  function handleProjectExport() {
    if (!projectDir) {
      setError('No project directory available. Save the workflow to a project first.')
      return
    }
    runExport({ type: 'project', projectDir })
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

        {step === 'exporting' && (
          <div className="export-flow-step export-flow-step--centered">
            <div className="export-flow-spinner" aria-hidden="true" />
            <p className="export-flow-modal__subtitle">Exporting…</p>
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
