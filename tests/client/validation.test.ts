import { describe, it, expect } from 'vitest'
import { validateWorkflow } from '../../client/src/lib/validation.ts'
import type { CwcFile, CwcNode, CwcEdge } from '../../src/schema.ts'

function makeNode(overrides: { id?: string; name: string }): CwcNode {
  return {
    id: overrides.id ?? 'node-1',
    position: { x: 0, y: 0 },
    exportedSlug: null,
    agent: { name: overrides.name, description: 'desc', completionCriteria: '', model: 'inherit' },
  }
}

function makeMinimalCwc(overrides: { nodes: CwcNode[]; edges: CwcEdge[] }): CwcFile {
  return {
    meta: { id: 'test', name: 'Test', description: '', version: 1, created: '', updated: '' },
    nodes: overrides.nodes,
    edges: overrides.edges,
  }
}

describe('validateWorkflow', () => {
  it('returns error for empty workflow (zero nodes)', () => {
    const cwc = makeMinimalCwc({ nodes: [], edges: [] })
    const { errors } = validateWorkflow(cwc)
    expect(errors).toContainEqual(expect.objectContaining({ type: 'empty-workflow' }))
  })

  it('returns error for node with empty agent.name', () => {
    const cwc = makeMinimalCwc({ nodes: [makeNode({ id: 'node-1', name: '' })], edges: [] })
    const { errors } = validateWorkflow(cwc)
    expect(errors).toContainEqual(expect.objectContaining({ type: 'missing-name', nodeId: 'node-1' }))
  })

  it('warns on disconnected node (no edges)', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'A' }), makeNode({ id: 'n2', name: 'B' })],
      edges: [],
    })
    const { warnings } = validateWorkflow(cwc)
    expect(warnings.some((w) => w.type === 'disconnected-node')).toBe(true)
  })

  it('warns on duplicate slug', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'Backend Architect' }), makeNode({ id: 'n2', name: 'Backend Architect' })],
      edges: [],
    })
    const { warnings } = validateWorkflow(cwc)
    expect(warnings.some((w) => w.type === 'duplicate-slug')).toBe(true)
  })

  it('canExport is true when no errors', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'Developer' })],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'done', terminalType: 'complete', context: [] }],
    })
    const { canExport } = validateWorkflow(cwc)
    expect(canExport).toBe(true)
  })
})
