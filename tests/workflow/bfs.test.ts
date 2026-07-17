import { describe, it, expect } from 'vitest'
import { bfsTraversal } from '../../src/workflow/bfs.js'
import type { CwcNode, CwcEdge } from '../../src/schema.js'

const node = (id: string): CwcNode => ({
  id,
  position: { x: 0, y: 0 },
  exportedSlug: null,
  agent: { name: id, description: '', completionCriteria: '', color: 'blue' },
})

const edge = (from: string, to: string | null, id?: string): CwcEdge => ({
  id: id ?? `${from}->${to}`,
  from,
  to,
  trigger: `Trigger from ${from}`,
  context: [],
})

describe('bfsTraversal', () => {
  it('returns nodes in BFS order for A→B→C', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'B'), edge('B', 'C')]
    const steps = bfsTraversal(nodes, edges)
    expect(steps.map(s => s.node.id)).toEqual(['A', 'B', 'C'])
  })

  it('marks back-edges without recursing', () => {
    const nodes = [node('A'), node('B')]
    const edges = [edge('A', 'B'), edge('B', 'A')]
    const steps = bfsTraversal(nodes, edges)
    // A and B visited; B→A edge should be marked as back-edge
    const bStep = steps.find(s => s.node.id === 'B')!
    expect(bStep.outgoingEdges.some(e => e.isBackEdge)).toBe(true)
  })

  it('groups fan-out nodes at same BFS level as parallel', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'B'), edge('A', 'C')]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps.find(s => s.node.id === 'A')!
    expect(aStep.outgoingEdges.every(e => !e.isBackEdge)).toBe(true)
    // B and C should appear at the same BFS level
    const bStep = steps.find(s => s.node.id === 'B')!
    const cStep = steps.find(s => s.node.id === 'C')!
    expect(bStep.level).toBe(cStep.level)
  })

  it('handles multiple disconnected entry nodes as multi-root BFS', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'C'), edge('B', 'C')]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps.find(s => s.node.id === 'A')!
    const bStep = steps.find(s => s.node.id === 'B')!
    expect(aStep.level).toBe(0)
    expect(bStep.level).toBe(0)
  })

  it('returns terminal edges (to: null) on the source node step', () => {
    const nodes = [node('A')]
    const edges = [{ ...edge('A', null), terminalType: 'complete' as const }]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps[0]
    expect(aStep.outgoingEdges.some(e => e.edge.to === null)).toBe(true)
  })

  it('orders an acyclic join after every uneven branch predecessor', () => {
    const nodes = [node('A'), node('B'), node('C'), node('D'), node('E'), node('J')]
    const edges = [
      edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('D', 'E'),
      edge('C', 'J'), edge('E', 'J'),
    ]
    const steps = bfsTraversal(nodes, edges)
    const order = steps.map(step => step.node.id)

    expect(order.indexOf('J')).toBeGreaterThan(order.indexOf('C'))
    expect(order.indexOf('J')).toBeGreaterThan(order.indexOf('E'))
    expect(steps.find(step => step.node.id === 'E')?.outgoingEdges[0].isBackEdge).toBe(false)
  })
})
