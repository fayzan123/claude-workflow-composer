import { useReducer } from 'react'
import type { CwcFile, CwcNode, CwcEdge, CwcAgent } from '../types.ts'
import { v4 as uuidv4 } from 'uuid'

export type WorkflowAction =
  | { type: 'LOAD'; payload: CwcFile }
  | { type: 'SET_META'; payload: Partial<CwcFile['meta']> }
  | { type: 'ADD_NODE'; payload: { agent: CwcAgent; position: { x: number; y: number }; agentRef?: string } }
  | { type: 'UPDATE_NODE'; payload: { nodeId: string; agent: Partial<CwcAgent>; startTrigger?: string; dispatchMode?: 'parallel' | 'conditional' } }
  | { type: 'MOVE_NODE'; payload: { nodeId: string; position: { x: number; y: number } } }
  | { type: 'REMOVE_NODE'; payload: { nodeId: string } }
  | { type: 'ADD_EDGE'; payload: Omit<CwcEdge, 'id'> }
  | { type: 'UPDATE_EDGE'; payload: { edgeId: string } & Partial<Omit<CwcEdge, 'id'>> }
  | { type: 'REMOVE_EDGE'; payload: { edgeId: string } }
  | { type: 'UPDATE_EXPORTED_SLUG'; payload: { nodeId: string; slug: string } }

function reducer(state: CwcFile, action: WorkflowAction): CwcFile {
  const now = new Date().toISOString()
  switch (action.type) {
    case 'LOAD': return action.payload
    case 'SET_META': return { ...state, meta: { ...state.meta, ...action.payload, updated: now } }
    case 'ADD_NODE': {
      const node: CwcNode = {
        id: `node-${uuidv4().slice(0, 8)}`,
        position: action.payload.position,
        exportedSlug: null,
        agent: action.payload.agent,
        agentRef: action.payload.agentRef,
      }
      return { ...state, nodes: [...state.nodes, node], meta: { ...state.meta, updated: now } }
    }
    case 'UPDATE_NODE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      nodes: state.nodes.map((n) =>
        n.id === action.payload.nodeId
          ? { ...n, agent: { ...n.agent, ...action.payload.agent }, startTrigger: action.payload.startTrigger ?? n.startTrigger, dispatchMode: action.payload.dispatchMode ?? n.dispatchMode }
          : n
      ),
    }
    case 'MOVE_NODE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      nodes: state.nodes.map((n) => n.id === action.payload.nodeId ? { ...n, position: action.payload.position } : n),
    }
    case 'REMOVE_NODE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      nodes: state.nodes.filter((n) => n.id !== action.payload.nodeId),
      edges: state.edges.filter((e) => e.from !== action.payload.nodeId && e.to !== action.payload.nodeId),
    }
    case 'ADD_EDGE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      edges: [...state.edges, { id: `edge-${uuidv4().slice(0, 8)}`, ...action.payload }],
    }
    case 'UPDATE_EDGE': {
      const { edgeId, ...rest } = action.payload
      return {
        ...state,
        meta: { ...state.meta, updated: now },
        edges: state.edges.map((e) => e.id === edgeId ? { ...e, ...rest } : e),
      }
    }
    case 'REMOVE_EDGE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      edges: state.edges.filter((e) => e.id !== action.payload.edgeId),
    }
    case 'UPDATE_EXPORTED_SLUG': return {
      ...state,
      nodes: state.nodes.map((n) => n.id === action.payload.nodeId ? { ...n, exportedSlug: action.payload.slug } : n),
    }
    default: return state
  }
}

function makeEmptyWorkflow(): CwcFile {
  const now = new Date().toISOString()
  return {
    meta: { id: '', name: 'Untitled Workflow', description: '', version: 1, created: now, updated: now },
    nodes: [],
    edges: [],
  }
}

export function useWorkflow(initial?: CwcFile) {
  const [workflow, dispatch] = useReducer(reducer, initial ?? makeEmptyWorkflow())
  return { workflow, dispatch }
}
