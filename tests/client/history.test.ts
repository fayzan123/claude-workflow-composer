import { describe, it, expect } from 'vitest'
import { historyReducer, type HistoryState } from '../../client/src/hooks/useWorkflow.ts'
import type { CwcFile, CwcAgent } from '../../client/src/types.ts'

function emptyWorkflow(): CwcFile {
  const now = new Date().toISOString()
  return {
    meta: { id: 'wf1', name: 'Test', description: '', version: 1, created: now, updated: now },
    nodes: [],
    edges: [],
  }
}

function initial(): HistoryState {
  return { past: [], present: emptyWorkflow(), future: [], lastKey: null }
}

const agent: CwcAgent = { name: 'A', description: '', completionCriteria: '', systemPrompt: '', tools: [], skills: [] }

describe('historyReducer', () => {
  it('records a node add and undoes it', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.past).toHaveLength(1)

    const undone = historyReducer(s, { type: 'UNDO' })
    expect(undone.present.nodes).toHaveLength(0)
    expect(undone.future).toHaveLength(1)
  })

  it('redoes an undone action', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'UNDO' })
    s = historyReducer(s, { type: 'REDO' })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.future).toHaveLength(0)
  })

  it('restores a deleted node via undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId } })
    expect(s.present.nodes).toHaveLength(0)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.present.nodes[0].id).toBe(nodeId)
  })

  it('coalesces consecutive edits to the same node into one undo step', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastAfterAdd = s.past.length

    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'a' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'ab' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'abc' } } })

    // Three keystrokes add exactly one undo step on top of the add.
    expect(s.past).toHaveLength(pastAfterAdd + 1)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes[0].agent.description).toBe('')
  })

  it('does not coalesce edits to different nodes', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 1 } } })
    const [n1, n2] = s.present.nodes
    const base = s.past.length

    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId: n1.id, agent: { description: 'x' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId: n2.id, agent: { description: 'y' } } })
    expect(s.past).toHaveLength(base + 2)
  })

  it('clears the redo stack on a new action after undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'UNDO' })
    expect(s.future).toHaveLength(1)
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 5, y: 5 } } })
    expect(s.future).toHaveLength(0)
  })

  it('UNDO/REDO at the boundaries are no-ops', () => {
    const s = initial()
    expect(historyReducer(s, { type: 'UNDO' })).toBe(s)
    expect(historyReducer(s, { type: 'REDO' })).toBe(s)
  })

  it('LOAD resets history', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'LOAD', payload: emptyWorkflow() })
    expect(s.past).toHaveLength(0)
    expect(s.future).toHaveLength(0)
  })

  it('UPDATE_EXPORTED_SLUG does not touch the undo stack', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastBefore = s.past.length
    s = historyReducer(s, { type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId, slug: 'a' } })
    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.nodes[0].exportedSlug).toBe('a')
  })
})
