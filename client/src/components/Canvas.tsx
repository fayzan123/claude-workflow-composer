import React, { useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CwcFile, CwcAgent } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ValidationResult } from '../lib/validation.ts'
import { WorkflowNode } from './WorkflowNode.tsx'
import './Canvas.css'

const nodeTypes = { workflowNode: WorkflowNode }

interface Props {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  validation: ValidationResult
  onSelectNode: (nodeId: string | null) => void
  onSelectEdge: (edgeId: string | null) => void
  selectedNodeId: string | null
  selectedEdgeId: string | null
}

export function Canvas({ workflow, dispatch, validation, onSelectNode, onSelectEdge, selectedNodeId, selectedEdgeId }: Props) {
  const rfNodes = workflow.nodes.map((n) => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position,
    data: {
      ...n,
      warnings: validation.warnings.filter((w) => w.nodeId === n.id),
      errors: validation.errors.filter((e) => e.nodeId === n.id),
      isSelected: n.id === selectedNodeId,
    },
    selected: n.id === selectedNodeId,
  }))

  const rfEdges = workflow.edges
    .filter((e) => e.to !== null)
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to!,
      label: e.label,
      selected: e.id === selectedEdgeId,
    }))

  const onConnect = useCallback((connection: Connection) => {
    dispatch({
      type: 'ADD_EDGE',
      payload: { from: connection.source, to: connection.target, trigger: '', context: [] },
    })
  }, [dispatch])

  const onNodeDragStop = useCallback((_: React.MouseEvent, node: { id: string; position: { x: number; y: number } }) => {
    dispatch({ type: 'MOVE_NODE', payload: { nodeId: node.id, position: node.position } })
  }, [dispatch])

  const onNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    onSelectNode(node.id)
    onSelectEdge(null)
  }, [onSelectNode, onSelectEdge])

  const onEdgeClick: EdgeMouseHandler = useCallback((_evt, edge) => {
    onSelectEdge(edge.id)
    onSelectNode(null)
  }, [onSelectEdge, onSelectNode])

  const onPaneClick = useCallback(() => {
    onSelectNode(null)
    onSelectEdge(null)
  }, [onSelectNode, onSelectEdge])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()

    const agentData = event.dataTransfer.getData('application/cwc-agent')
    if (agentData) {
      const agent: CwcAgent = JSON.parse(agentData)
      const canvasEl = (event.currentTarget as HTMLElement)
      const rect = canvasEl.getBoundingClientRect()
      dispatch({
        type: 'ADD_NODE',
        payload: { agent, position: { x: event.clientX - rect.left - 75, y: event.clientY - rect.top - 40 } },
      })
      return
    }

    const skillData = event.dataTransfer.getData('application/cwc-skill')
    if (skillData && selectedNodeId) {
      const { namespacedSlug } = JSON.parse(skillData) as { namespacedSlug: string }
      const currentNode = workflow.nodes.find((n) => n.id === selectedNodeId)
      if (currentNode) {
        const currentSkills = currentNode.agent.skills ?? []
        if (!currentSkills.includes(namespacedSlug)) {
          dispatch({
            type: 'UPDATE_NODE',
            payload: { nodeId: selectedNodeId, agent: { skills: [...currentSkills, namespacedSlug] } },
          })
        }
      }
    }
  }, [dispatch, selectedNodeId, workflow.nodes])

  return (
    <div className="canvas-wrapper" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  )
}
