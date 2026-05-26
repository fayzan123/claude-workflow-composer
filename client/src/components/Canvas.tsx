import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  type Connection,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type NodeChange,
  type Node,
  type Edge,
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
  const { screenToFlowPosition } = useReactFlow()

  const rfNodes = useMemo(() => workflow.nodes.map((n) => ({
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
  })), [workflow.nodes, validation, selectedNodeId])

  const [nodes, setNodes] = useState<Node[]>(rfNodes)
  const isDragging = useRef(false)

  useEffect(() => {
    if (isDragging.current) return
    setNodes(rfNodes)
  }, [rfNodes])

  const rfEdges = useMemo(() => workflow.edges
    .filter((e) => e.to !== null)
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to!,
      label: e.label,
      selected: e.id === selectedEdgeId,
      animated: true,
    })), [workflow.edges, selectedEdgeId])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    dispatch({
      type: 'ADD_EDGE',
      payload: { from: connection.source, to: connection.target, trigger: '', context: [] },
    })
  }, [dispatch])

  const onNodeDragStart = useCallback(() => {
    isDragging.current = true
  }, [])

  const onNodeDragStop = useCallback((_: React.MouseEvent, node: { id: string; position: { x: number; y: number } }) => {
    isDragging.current = false
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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (selectedNodeId) {
        dispatch({ type: 'REMOVE_NODE', payload: { nodeId: selectedNodeId } })
        onSelectNode(null)
      } else if (selectedEdgeId) {
        dispatch({ type: 'REMOVE_EDGE', payload: { edgeId: selectedEdgeId } })
        onSelectEdge(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dispatch, selectedNodeId, selectedEdgeId, onSelectNode, onSelectEdge])

  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    dispatch({
      type: 'UPDATE_EDGE',
      payload: { edgeId: oldEdge.id, from: newConnection.source, to: newConnection.target },
    })
  }, [dispatch])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()

    const agentRefData = event.dataTransfer.getData('application/cwc-agent-ref')
    if (agentRefData) {
      let parsed: { agentRef: string; name: string; description: string }
      try {
        parsed = JSON.parse(agentRefData) as { agentRef: string; name: string; description: string }
      } catch {
        console.error('cwc-agent-ref drag payload was not valid JSON')
        return
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const agent: CwcAgent = {
        name: parsed.name,
        description: parsed.description,
        completionCriteria: '',
        systemPrompt: '',
        tools: [],
        skills: [],
      }
      dispatch({
        type: 'ADD_NODE',
        payload: { agent, position, agentRef: parsed.agentRef },
      })
      return
    }

    const agentData = event.dataTransfer.getData('application/cwc-agent')
    if (agentData) {
      let agent: CwcAgent
      try {
        agent = JSON.parse(agentData) as CwcAgent
      } catch {
        console.error('cwc-agent drag payload was not valid JSON')
        return
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      dispatch({
        type: 'ADD_NODE',
        payload: { agent, position },
      })
      return
    }

    const skillData = event.dataTransfer.getData('application/cwc-skill')
    if (skillData) {
      let parsed: { namespacedSlug: string }
      try {
        parsed = JSON.parse(skillData) as { namespacedSlug: string }
      } catch {
        console.error('cwc-skill drag payload was not valid JSON')
        return
      }
      const { namespacedSlug } = parsed
      const droppedOnNodeEl = (event.target as HTMLElement).closest<HTMLElement>('[data-id]')
      const targetNodeId = droppedOnNodeEl?.dataset.id ?? selectedNodeId
      if (!targetNodeId) return
      const currentNode = workflow.nodes.find((n) => n.id === targetNodeId)
      if (currentNode) {
        const currentSkills = currentNode.agent.skills ?? []
        if (!currentSkills.includes(namespacedSlug)) {
          dispatch({
            type: 'UPDATE_NODE',
            payload: { nodeId: targetNodeId, agent: { skills: [...currentSkills, namespacedSlug] } },
          })
        }
      }
    }
  }, [dispatch, selectedNodeId, workflow.nodes, screenToFlowPosition])

  return (
    <div className="canvas-wrapper" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} tabIndex={0}>
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onReconnect={onReconnect}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  )
}
