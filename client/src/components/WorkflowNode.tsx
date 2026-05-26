import React from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { ValidationWarning, ValidationError } from '../lib/validation.ts'
import { slugify } from '../../../src/slugify.ts'

export interface WorkflowNodeData {
  id: string
  position: { x: number; y: number }
  exportedSlug: string | null
  agent: {
    name: string
    description: string
    completionCriteria: string
    color?: string
    model?: string
  }
  agentRef?: string
  startTrigger?: string
  warnings: ValidationWarning[]
  errors: ValidationError[]
  isSelected: boolean
}

export function WorkflowNode({ data }: NodeProps) {
  const nodeData = data as unknown as WorkflowNodeData
  const hasIssues = nodeData.warnings.length > 0 || nodeData.errors.length > 0
  const hasErrors = nodeData.errors.length > 0
  const accentColor = nodeData.agent.color ?? '#6366f1'
  const isRef = !!nodeData.agentRef

  return (
    <div
      className={`workflow-node ${isRef ? 'workflow-node--ref' : ''} ${hasErrors ? 'workflow-node--error' : hasIssues ? 'workflow-node--warning' : ''} ${nodeData.isSelected ? 'workflow-node--selected' : ''}`}
      style={{ '--node-accent': accentColor } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      <div className="workflow-node__accent" />
      <div className="workflow-node__header">
        <div className="workflow-node__name-row">
          <span className="workflow-node__name">{nodeData.agent.name || 'Unnamed Agent'}</span>
          {isRef && <span className="workflow-node__ref-indicator" title={`References agent: ${nodeData.agentRef}`}>Ref</span>}
          {hasErrors && <span className="workflow-node__status-badge workflow-node__status-badge--error" title={nodeData.errors.map(e => e.message).join('\n')}>!</span>}
          {!hasErrors && hasIssues && <span className="workflow-node__status-badge workflow-node__status-badge--warning" title={nodeData.warnings.map(w => w.message).join('\n')}>!</span>}
        </div>
      </div>
      {nodeData.agent.description && (
        <div className="workflow-node__desc">{nodeData.agent.description}</div>
      )}
      <div className="workflow-node__footer">
        <span className="workflow-node__slug">{isRef ? nodeData.agentRef : (nodeData.agent.name ? slugify(nodeData.agent.name) : '...')}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
