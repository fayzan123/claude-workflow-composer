import React from 'react'
import type { CwcEdge, CwcArtifact, ArtifactType, TerminalType } from '../../../../src/schema.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import './EdgePanel.css'

interface Props {
  edge: CwcEdge
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
}

const TERMINAL_TYPES: TerminalType[] = ['complete', 'escalated', 'aborted']
const ARTIFACT_TYPES: ArtifactType[] = ['file', 'text', 'json']

export function EdgePanel({ edge, dispatch, onClose }: Props) {
  function updateEdge(partial: Partial<Omit<CwcEdge, 'id'>>) {
    dispatch({ type: 'UPDATE_EDGE', payload: { edgeId: edge.id, ...partial } })
  }

  function handleTriggerChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    updateEdge({ trigger: e.target.value })
  }

  function handleLabelChange(e: React.ChangeEvent<HTMLInputElement>) {
    updateEdge({ label: e.target.value || undefined })
  }

  function handleTerminalTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    updateEdge({ terminalType: e.target.value as TerminalType })
  }

  function handleAddArtifact() {
    const current = edge.context ?? []
    const newArtifact: CwcArtifact = { name: '', type: 'text' }
    updateEdge({ context: [...current, newArtifact] })
  }

  function handleRemoveArtifact(index: number) {
    const current = edge.context ?? []
    updateEdge({ context: current.filter((_, i) => i !== index) })
  }

  function handleArtifactChange(index: number, partial: Partial<CwcArtifact>) {
    const current = edge.context ?? []
    const updated = current.map((a, i) => i === index ? { ...a, ...partial } : a)
    updateEdge({ context: updated })
  }

  function handleArtifactTypeChange(index: number, newType: ArtifactType) {
    const current = edge.context ?? []
    const artifact = current[index]
    const updated: CwcArtifact = { name: artifact.name, type: newType }
    if (newType === 'file') {
      updated.path = artifact.path ?? ''
    }
    const next = current.map((a, i) => i === index ? updated : a)
    updateEdge({ context: next })
  }

  return (
    <aside className="edge-panel">
      <div className="edge-panel__header">
        <span className="edge-panel__title">Edge Editor</span>
        <button className="edge-panel__close" onClick={onClose} aria-label="Close panel">×</button>
      </div>

      <div className="edge-panel__body">
        <div className="edge-panel__field">
          <label className="edge-panel__label edge-panel__label--required">Trigger *</label>
          <textarea
            className="edge-panel__textarea"
            value={edge.trigger}
            onChange={handleTriggerChange}
            placeholder="What triggers this transition?"
            rows={3}
          />
        </div>

        <div className="edge-panel__field">
          <label className="edge-panel__label">Label</label>
          <input
            className="edge-panel__input"
            type="text"
            value={edge.label ?? ''}
            onChange={handleLabelChange}
            placeholder="Optional display label"
          />
        </div>

        {edge.to === null && (
          <div className="edge-panel__field">
            <label className="edge-panel__label">Terminal Type</label>
            <select
              className="edge-panel__select"
              value={edge.terminalType ?? ''}
              onChange={handleTerminalTypeChange}
            >
              <option value="">-- select --</option>
              {TERMINAL_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        )}

        <div className="edge-panel__field">
          <label className="edge-panel__label">Context / Artifacts</label>
          <div className="edge-panel__artifacts">
            {(edge.context ?? []).map((artifact, index) => (
              <div key={`${artifact.name}-${artifact.type}-${index}`} className="edge-panel__artifact">
                <div className="edge-panel__artifact-row">
                  <input
                    className="edge-panel__input edge-panel__input--flex"
                    type="text"
                    value={artifact.name}
                    onChange={(e) => handleArtifactChange(index, { name: e.target.value })}
                    placeholder="Artifact name"
                  />
                  <select
                    className="edge-panel__select edge-panel__select--sm"
                    value={artifact.type}
                    onChange={(e) => handleArtifactTypeChange(index, e.target.value as ArtifactType)}
                  >
                    {ARTIFACT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <button
                    className="edge-panel__artifact-remove"
                    onClick={() => handleRemoveArtifact(index)}
                    aria-label={`Remove artifact ${artifact.name}`}
                  >×</button>
                </div>
                {artifact.type === 'file' && (
                  <input
                    className="edge-panel__input"
                    type="text"
                    value={artifact.path ?? ''}
                    onChange={(e) => handleArtifactChange(index, { path: e.target.value })}
                    placeholder="File path"
                  />
                )}
              </div>
            ))}
          </div>
          <button className="edge-panel__btn edge-panel__btn--add" onClick={handleAddArtifact}>
            + Add Artifact
          </button>
        </div>
      </div>
    </aside>
  )
}
