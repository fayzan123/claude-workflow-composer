import React from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { ValidationWarning, ValidationError } from '../lib/validation.ts'
import { slugify } from '../../../src/slugify.ts'
import { modelChipLabel } from '../lib/models.ts'

interface WorkflowNodeData {
  id: string
  position: { x: number; y: number }
  exportedSlug: string | null
  agent: {
    name: string
    description: string
    completionCriteria: string
    color?: string
    model?: string
    skills?: string[]
  }
  agentRef?: string
  nodeType?: 'agent' | 'gate'
  startTrigger?: string
  dispatchMode?: 'parallel' | 'conditional'
  warnings: ValidationWarning[]
  errors: ValidationError[]
  isSelected: boolean
  runState?: 'active' | 'done'
  triggerPills?: string[]
}

export function WorkflowNode({ data }: NodeProps) {
  const nodeData = data as unknown as WorkflowNodeData

  if (nodeData.nodeType === 'gate') {
    return (
      <div className={`workflow-node workflow-node--gate ${nodeData.isSelected ? 'workflow-node--selected' : ''} ${nodeData.runState === 'active' ? 'workflow-node--run-active' : ''}`}>
        <Handle type="target" position={Position.Left} />
        <span className="workflow-node__gate-icon" aria-hidden="true" />
        <span className="workflow-node__gate-label">{nodeData.agent.name || 'Approval Gate'}</span>
        <Handle type="source" position={Position.Right} />
      </div>
    )
  }

  const hasIssues = nodeData.warnings.length > 0 || nodeData.errors.length > 0
  const hasErrors = nodeData.errors.length > 0
  // Node-type color language: agent → teal (brand default), ref → muted neutral
  const isRef = !!nodeData.agentRef
  const accentColor = nodeData.agent.color
    ?? (isRef ? 'var(--color-text-tertiary)' : 'var(--color-primary)')
  const isRouter = nodeData.dispatchMode === 'conditional'

  return (
    <div
      className={`workflow-node ${isRef ? 'workflow-node--ref' : ''} ${hasErrors ? 'workflow-node--error' : hasIssues ? 'workflow-node--warning' : ''} ${nodeData.isSelected ? 'workflow-node--selected' : ''} ${nodeData.runState === 'active' ? 'workflow-node--run-active' : ''} ${nodeData.runState === 'done' ? 'workflow-node--run-done' : ''}`}
      style={{ '--node-accent': accentColor } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      {nodeData.triggerPills && nodeData.triggerPills.length > 0 && (
        <div className="workflow-node__trigger-pills">
          {nodeData.triggerPills.map((p, i) => <span key={i} className="workflow-node__trigger-pill">{p}</span>)}
        </div>
      )}
      <div className="workflow-node__accent" />
      <div className="workflow-node__header">
        <div className="workflow-node__name-row">
          <span className="workflow-node__name">{nodeData.agent.name || 'Unnamed Agent'}</span>
          {isRef && <span className="workflow-node__ref-indicator" title={`References agent: ${nodeData.agentRef}`}>Ref</span>}
          {isRouter && <span className="workflow-node__router-indicator" title="Conditional branch: one outgoing edge fires based on result">⬦ Router</span>}
          {hasErrors && <span className="workflow-node__status-badge workflow-node__status-badge--error" title={nodeData.errors.map(e => e.message).join('\n')}>!</span>}
          {!hasErrors && hasIssues && <span className="workflow-node__status-badge workflow-node__status-badge--warning" title={nodeData.warnings.map(w => w.message).join('\n')}>!</span>}
          {nodeData.runState === 'done' && <span className="workflow-node__run-check">Done</span>}
        </div>
      </div>
      {nodeData.agent.description && (
        <div className="workflow-node__desc">{nodeData.agent.description}</div>
      )}
      {nodeData.agent.skills && nodeData.agent.skills.length > 0 && (
        <div className="workflow-node__skills">
          {nodeData.agent.skills.map((s) => (
            <span key={s} className="workflow-node__skill-chip" title={s}>
              {s.includes(':') ? s.split(':').pop() : s}
            </span>
          ))}
        </div>
      )}
      <div className="workflow-node__footer">
        <span className="workflow-node__slug">{isRef ? nodeData.agentRef : (nodeData.agent.name ? slugify(nodeData.agent.name) : '...')}</span>
        {nodeData.agent.model && (
          <span className="workflow-node__model-chip">{modelChipLabel(nodeData.agent.model)}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
