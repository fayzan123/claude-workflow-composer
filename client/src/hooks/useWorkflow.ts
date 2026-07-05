import { useReducer } from 'react'
import type { CwcFile, CwcNode, CwcEdge, CwcAgent } from '../types.ts'
import { v4 as uuidv4 } from 'uuid'

export type WorkflowAction =
  | { type: 'LOAD'; payload: CwcFile }
  | { type: 'SET_META'; payload: Partial<CwcFile['meta']> }
  | { type: 'ADD_NODE'; payload: { agent: CwcAgent; position: { x: number; y: number }; agentRef?: string; nodeType?: 'agent' | 'gate' } }
  | { type: 'UPDATE_NODE'; payload: { nodeId: string; agent: Partial<CwcAgent>; startTrigger?: string; dispatchMode?: 'parallel' | 'conditional' } }
  | { type: 'MOVE_NODE'; payload: { nodeId: string; position: { x: number; y: number } } }
  | { type: 'REMOVE_NODE'; payload: { nodeId: string } }
  | { type: 'ADD_EDGE'; payload: Omit<CwcEdge, 'id'> }
  | { type: 'UPDATE_EDGE'; payload: { edgeId: string } & Partial<Omit<CwcEdge, 'id'>> }
  | { type: 'REMOVE_EDGE'; payload: { edgeId: string } }
  | { type: 'UPDATE_EXPORTED_SLUG'; payload: { nodeId: string; slug: string } }
  | { type: 'SET_EXPORTED_WORKFLOW_SLUG'; payload: { slug: string } }
  | { type: 'UNDO' }
  | { type: 'REDO' }

function reducer(state: CwcFile, action: WorkflowAction): CwcFile {
  const now = new Date().toISOString()
  switch (action.type) {
    case 'LOAD': return action.payload
    case 'UNDO':
    case 'REDO': return state
    case 'SET_META': return { ...state, meta: { ...state.meta, ...action.payload, updated: now } }
    case 'ADD_NODE': {
      const node: CwcNode = {
        id: `node-${uuidv4().slice(0, 8)}`,
        position: action.payload.position,
        exportedSlug: null,
        agent: action.payload.agent,
        agentRef: action.payload.agentRef,
        nodeType: action.payload.nodeType,
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
    case 'SET_EXPORTED_WORKFLOW_SLUG': return {
      ...state,
      meta: { ...state.meta, exportedWorkflowSlug: action.payload.slug },
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

const MAX_HISTORY = 100

export interface HistoryState {
  past: CwcFile[]
  present: CwcFile
  future: CwcFile[]
  lastKey: string | null
}

// Rapid edits that share a coalesce key (typing in a text field, retitling) collapse
// into a single undo step instead of one step per keystroke.
function coalesceKey(action: WorkflowAction): string | null {
  switch (action.type) {
    case 'SET_META': return 'meta'
    case 'UPDATE_NODE': return `update:${action.payload.nodeId}`
    case 'MOVE_NODE': return `move:${action.payload.nodeId}`
    default: return null
  }
}

export function historyReducer(state: HistoryState, action: WorkflowAction): HistoryState {
  switch (action.type) {
    case 'LOAD':
      return { past: [], present: reducer(state.present, action), future: [], lastKey: null }
    case 'UNDO': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], lastKey: null }
    }
    case 'REDO': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1), lastKey: null }
    }
    // Post-export bookkeeping — should never land on the undo stack.
    case 'UPDATE_EXPORTED_SLUG':
    case 'SET_EXPORTED_WORKFLOW_SLUG':
      return {
        ...state,
        past: state.past.map((snapshot) => reducer(snapshot, action)),
        present: reducer(state.present, action),
        future: state.future.map((snapshot) => reducer(snapshot, action)),
      }
    default: {
      const present = reducer(state.present, action)
      if (present === state.present) return state
      const key = coalesceKey(action)
      const coalesce = key !== null && key === state.lastKey
      const past = coalesce ? state.past : [...state.past, state.present].slice(-MAX_HISTORY)
      return { past, present, future: [], lastKey: key }
    }
  }
}

export function useWorkflow(initial?: CwcFile) {
  const [state, dispatch] = useReducer(
    historyReducer,
    undefined,
    (): HistoryState => ({ past: [], present: initial ?? makeEmptyWorkflow(), future: [], lastKey: null })
  )
  return { workflow: state.present, dispatch, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
