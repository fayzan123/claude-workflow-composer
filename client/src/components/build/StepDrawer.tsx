import React from 'react'
import { Drawer } from '../common/Drawer.tsx'
import { NodePanel } from '../panels/NodePanel.tsx'
import { EdgePanel } from '../panels/EdgePanel.tsx'
import type { CwcNode, CwcEdge, CwcFile } from '../../../../src/schema.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import './StepDrawer.css'

interface StepDrawerProps {
  /** The node being edited, or null if none. */
  selectedNode: CwcNode | null
  /** The edge being edited, or null if none. */
  selectedEdge: CwcEdge | null
  isEntryNode: boolean
  terminalEdge: CwcEdge | null
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  /** Called when the drawer should close (deselects the current item). */
  onClose: () => void
  onDeleteNode: () => void
  onDeleteEdge: () => void
}

/**
 * StepDrawer — wraps the Drawer primitive and renders NodePanel or EdgePanel
 * in embedded mode (no duplicate header/close). The Drawer's own header provides
 * the title and × close button. Delete is surfaced as a button in the drawer footer.
 */
export function StepDrawer({
  selectedNode,
  selectedEdge,
  isEntryNode,
  terminalEdge,
  workflow,
  dispatch,
  onClose,
  onDeleteNode,
  onDeleteEdge,
}: StepDrawerProps) {
  const open = selectedNode !== null || selectedEdge !== null

  const isGate = selectedNode?.nodeType === 'gate'
  const drawerTitle = selectedNode
    ? (isGate ? 'Edit gate' : 'Edit step')
    : 'Edit connection'

  function handleDelete() {
    if (selectedNode) {
      onDeleteNode()
    } else if (selectedEdge) {
      onDeleteEdge()
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={drawerTitle}>
      {selectedNode && (
        <NodePanel
          node={selectedNode}
          isEntryNode={isEntryNode}
          terminalEdge={terminalEdge}
          workflow={workflow}
          dispatch={dispatch}
          onClose={onClose}
          onDelete={onDeleteNode}
          embedded
        />
      )}
      {selectedEdge && (
        <EdgePanel
          edge={selectedEdge}
          nodes={workflow.nodes}
          dispatch={dispatch}
          onClose={onClose}
          onDelete={onDeleteEdge}
          embedded
        />
      )}
      <div className="step-drawer__footer">
        <button
          type="button"
          className="step-drawer__delete"
          onClick={handleDelete}
        >
          Delete {selectedNode ? (isGate ? 'gate' : 'step') : 'connection'}
        </button>
      </div>
    </Drawer>
  )
}
