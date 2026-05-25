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
  startTrigger?: string
  warnings: ValidationWarning[]
  errors: ValidationError[]
  isSelected: boolean
}

export function WorkflowNode({ data }: NodeProps) {
  const nodeData = data as unknown as WorkflowNodeData
  const hasIssues = nodeData.warnings.length > 0 || nodeData.errors.length > 0
  const hasErrors = nodeData.errors.length > 0

  return (
    <div className={`workflow-node ${hasErrors ? 'workflow-node--error' : hasIssues ? 'workflow-node--warning' : ''}`}
         style={{ borderLeftColor: nodeData.agent.color ?? '#6366f1' }}>
      <Handle type="target" position={Position.Left} />
      <div className="workflow-node__header">
        <span className="workflow-node__name">{nodeData.agent.name || 'Unnamed Agent'}</span>
        {hasIssues && <span className="workflow-node__badge">{hasErrors ? '!' : '⚠'}</span>}
      </div>
      {nodeData.agent.description && (
        <div className="workflow-node__desc">{nodeData.agent.description}</div>
      )}
      <div className="workflow-node__slug">→ {nodeData.agent.name ? slugify(nodeData.agent.name) : '...'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
