import { describe, it, expect } from 'vitest'
import { computeLayout } from '../../client/src/lib/layout.ts'
import type { CwcNode, CwcEdge } from '../../src/schema.ts'

function makeNode(id: string): CwcNode {
  return { id, position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: id, description: '', completionCriteria: '', model: 'inherit' } }
}

function makeEdge(from: string, to: string): CwcEdge {
  return { id: `${from}-${to}`, from, to, trigger: '', context: [] }
}

describe('computeLayout', () => {
  it('places single entry node at (0, 0)', () => {
    const positions = computeLayout([makeNode('A')], [])
    const pos = positions.get('A')!
    expect(pos.x).toBe(0)
    expect(pos.y).toBe(0)
  })

  it('places sequential chain A→B→C left-to-right with 300px horizontal spacing', () => {
    const nodes = ['A', 'B', 'C'].map(makeNode)
    const edges = [makeEdge('A', 'B'), makeEdge('B', 'C')]
    const positions = computeLayout(nodes, edges)
    expect(positions.get('A')!.x).toBe(0)
    expect(positions.get('B')!.x).toBe(300)
    expect(positions.get('C')!.x).toBe(600)
    expect(positions.get('A')!.y).toBe(positions.get('B')!.y)
  })

  it('places parallel fan-out B and C at same x, 200px vertical spacing', () => {
    const nodes = ['A', 'B', 'C'].map(makeNode)
    const edges = [makeEdge('A', 'B'), makeEdge('A', 'C')]
    const positions = computeLayout(nodes, edges)
    expect(positions.get('B')!.x).toBe(positions.get('C')!.x)
    expect(positions.get('B')!.x).toBe(300)
    const yDiff = Math.abs(positions.get('B')!.y - positions.get('C')!.y)
    expect(yDiff).toBe(200)
  })

  it('back-edges do not cause infinite loops', () => {
    const nodes = ['A', 'B'].map(makeNode)
    const edges = [makeEdge('A', 'B'), makeEdge('B', 'A')]
    expect(() => computeLayout(nodes, edges)).not.toThrow()
    const positions = computeLayout(nodes, edges)
    expect(positions.size).toBe(2)
  })
})
