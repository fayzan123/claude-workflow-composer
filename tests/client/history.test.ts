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

  it('REMOVE_NODE cascades deletion of every connected edge', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 2, y: 0 } } })
    const [n1, n2, n3] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'a→b' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: n3.id, trigger: 'b→c' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: null, trigger: 'done', terminalType: 'complete' } })

    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId: n2.id } })
    // Incoming, outgoing, AND terminal edges of n2 all go with it.
    expect(s.present.edges).toHaveLength(0)
    expect(s.present.nodes.map((n) => n.id)).toEqual([n1.id, n3.id])
  })

  it('undo after a node deletion restores its cascaded edges too', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    const [n1, n2] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'go' } })
    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId: n1.id } })
    expect(s.present.edges).toHaveLength(0)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(2)
    expect(s.present.edges).toHaveLength(1)
    expect(s.present.edges[0].trigger).toBe('go')
  })

  it('UPDATE_EDGE changes only the targeted edge and is undoable', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    const [n1, n2] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'first' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: null, trigger: 'second' } })
    const [e1, e2] = s.present.edges

    s = historyReducer(s, { type: 'UPDATE_EDGE', payload: { edgeId: e1.id, trigger: 'changed', label: 'L' } })
    expect(s.present.edges.find((e) => e.id === e1.id)).toMatchObject({ trigger: 'changed', label: 'L' })
    expect(s.present.edges.find((e) => e.id === e2.id)?.trigger).toBe('second')

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.edges.find((e) => e.id === e1.id)?.trigger).toBe('first')
  })

  it('REMOVE_EDGE deletes only the targeted edge', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const n1 = s.present.nodes[0]
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: null, trigger: 'a', terminalType: 'complete' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: null, trigger: 'b', terminalType: 'aborted' } })
    const e1 = s.present.edges[0]
    s = historyReducer(s, { type: 'REMOVE_EDGE', payload: { edgeId: e1.id } })
    expect(s.present.edges).toHaveLength(1)
    expect(s.present.edges[0].trigger).toBe('b')
  })

  it('coalesces consecutive SET_META edits into one undo step', () => {
    let s = initial()
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'A' } })
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Ab' } })
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Abc' } })
    expect(s.past).toHaveLength(1)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.meta.name).toBe('Test')
  })

  it('caps the undo stack at 100 entries', () => {
    let s = initial()
    for (let i = 0; i < 130; i++) {
      s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: i, y: 0 } } })
    }
    expect(s.past).toHaveLength(100)
    // The retained history is the most recent 100 states.
    expect(s.past[s.past.length - 1].nodes).toHaveLength(129)
    expect(s.past[0].nodes).toHaveLength(30)
  })

  it('UPDATE_EXPORTED_SLUG does not touch the undo stack', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastBefore = s.past.length
    s = historyReducer(s, { type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId, slug: 'a' } })
    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.nodes[0].exportedSlug).toBe('a')

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(0)
  })

  it('UPDATE_EXPORTED_SLUG survives undoing an edit to an existing node', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'changed' } } })
    const pastBefore = s.past.length

    s = historyReducer(s, { type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId, slug: 'exported-a' } })

    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.nodes[0].exportedSlug).toBe('exported-a')

    s = historyReducer(s, { type: 'UNDO' })

    expect(s.present.nodes[0].agent.description).toBe('')
    expect(s.present.nodes[0].exportedSlug).toBe('exported-a')
  })

  it('SET_EXPORTED_WORKFLOW_SLUG does not touch the undo stack or disappear on undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Renamed' } })
    const pastBefore = s.past.length

    s = historyReducer(s, { type: 'SET_EXPORTED_WORKFLOW_SLUG', payload: { slug: 'cwc-renamed' } })

    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.meta.exportedWorkflowSlug).toBe('cwc-renamed')

    s = historyReducer(s, { type: 'UNDO' })

    expect(s.present.meta.name).toBe('Test')
    expect(s.present.meta.exportedWorkflowSlug).toBe('cwc-renamed')
  })
})
