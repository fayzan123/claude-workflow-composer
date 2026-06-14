import React from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '../../components/Canvas.tsx'
import { Sidebar } from '../../components/Sidebar.tsx'
import { StepDrawer } from '../../components/build/StepDrawer.tsx'
import { OrchestratorPreview } from '../../components/OrchestratorPreview.tsx'
import type { ValidationResult } from '../../lib/validation.ts'
import type { ModeProps } from '../modeProps.ts'
import './BuildMode.css'

// BuildMode is now a pure body component — no header, no modals, no navigation.
// All chrome state (selected node/edge, show preview, show export, show help,
// show run modal, validation popover open state) is owned by WorkflowView and
// threaded down as props so the WorkflowHeader can remain mounted across mode
// switches without remounting.

interface Props extends ModeProps {
  workflowId: string
  validation: ValidationResult
  nodeRunStates: Record<string, 'active' | 'done'>
  selectedNodeId: string | null
  selectedEdgeId: string | null
  onSelectNode: (id: string | null) => void
  onSelectEdge: (id: string | null) => void
  showPreview: boolean
  onClosePreview: () => void
}

export function BuildMode({
  workflow,
  dispatch,
  validation,
  nodeRunStates,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  showPreview,
  onClosePreview,
}: Props) {
  const selectedNode = selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? workflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const isEntryNode = selectedNode ? !workflow.edges.some((e) => e.to === selectedNode.id) : false
  const terminalEdge = selectedNode ? (workflow.edges.find((e) => e.from === selectedNode.id && e.to === null) ?? null) : null

  return (
    <div className="build-mode">
      <div className="build-mode__body">
        <Sidebar />
        <ReactFlowProvider>
          <Canvas
            workflow={workflow}
            dispatch={dispatch}
            validation={validation}
            onSelectNode={onSelectNode}
            onSelectEdge={onSelectEdge}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            nodeRunStates={nodeRunStates}
          />
        </ReactFlowProvider>
        <StepDrawer
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          isEntryNode={isEntryNode}
          terminalEdge={terminalEdge}
          workflow={workflow}
          dispatch={dispatch}
          onClose={() => {
            onSelectNode(null)
            onSelectEdge(null)
          }}
          onDeleteNode={() => {
            if (selectedNode) {
              dispatch({ type: 'REMOVE_NODE', payload: { nodeId: selectedNode.id } })
              onSelectNode(null)
            }
          }}
          onDeleteEdge={() => {
            if (selectedEdge) {
              dispatch({ type: 'REMOVE_EDGE', payload: { edgeId: selectedEdge.id } })
              onSelectEdge(null)
            }
          }}
        />
        {!selectedNode && !selectedEdge && showPreview && (
          <OrchestratorPreview
            workflow={workflow}
            onClose={onClosePreview}
          />
        )}
      </div>
    </div>
  )
}
