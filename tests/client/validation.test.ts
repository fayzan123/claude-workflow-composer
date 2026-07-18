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
  it('returns canExport: false for empty workflow (zero nodes) with no error badge', () => {
    const cwc = makeMinimalCwc({ nodes: [], edges: [] })
    const { errors, canExport } = validateWorkflow(cwc)
    expect(errors).toHaveLength(0)
    expect(canExport).toBe(false)
  })

  it('returns error for node with empty agent.name', () => {
    const cwc = makeMinimalCwc({ nodes: [makeNode({ id: 'node-1', name: '' })], edges: [] })
    const { errors } = validateWorkflow(cwc)
    expect(errors).toContainEqual(expect.objectContaining({ type: 'missing-name', nodeId: 'node-1' }))
  })

  it('warns on disconnected node when other edges exist', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'A' }), makeNode({ id: 'n2', name: 'B' }), makeNode({ id: 'n3', name: 'C' })],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', trigger: '', context: [] }],
    })
    const { warnings } = validateWorkflow(cwc)
    expect(warnings.some((w) => w.type === 'disconnected-node' && w.nodeId === 'n3')).toBe(true)
  })

  it('does not warn on disconnected nodes when no edges exist yet', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'A' }), makeNode({ id: 'n2', name: 'B' })],
      edges: [],
    })
    const { warnings } = validateWorkflow(cwc)
    expect(warnings.some((w) => w.type === 'disconnected-node')).toBe(false)
  })

  it('errors on duplicate slug and blocks export', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'Backend Architect' }), makeNode({ id: 'n2', name: 'Backend Architect' })],
      edges: [],
    })
    const { errors, canExport } = validateWorkflow(cwc)
    expect(errors.some((e) => e.type === 'duplicate-slug')).toBe(true)
    expect(canExport).toBe(false)
  })

  it('canExport is true when no errors', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ id: 'n1', name: 'Developer' })],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'done', terminalType: 'complete', context: [] }],
    })
    const { canExport } = validateWorkflow(cwc)
    expect(canExport).toBe(true)
  })

  it('accepts one complete bespoke node as a skill', () => {
    const cwc = makeMinimalCwc({ nodes: [makeNode({ name: 'Review patch' })], edges: [] })
    cwc.meta.artifactKind = 'skill'
    cwc.meta.artifactTier = 'skill'
    cwc.nodes[0].agent.systemPrompt = 'Review the patch and report concrete findings.'
    cwc.nodes[0].agent.description = 'Review one patch.'
    expect(validateWorkflow(cwc)).toMatchObject({ errors: [], canExport: true })
  })

  it('blocks malformed or empty skill artifacts', () => {
    const cwc = makeMinimalCwc({
      nodes: [makeNode({ name: 'Review patch' })],
      edges: [{ id: 'done', from: 'node-1', to: null, trigger: 'Done', terminalType: 'complete' }],
    })
    cwc.meta.artifactKind = 'skill'
    cwc.meta.artifactTier = 'skill'
    cwc.nodes[0].agent.description = ''
    cwc.nodes[0].agent.systemPrompt = '   '
    const result = validateWorkflow(cwc)
    expect(result.canExport).toBe(false)
    expect(result.errors.map((error) => error.type)).toEqual(expect.arrayContaining([
      'invalid-skill-edges',
      'missing-description',
      'missing-body',
    ]))
  })
})

describe('gate validation', () => {
  function gateNode(id: string) {
    return { id, position: { x: 0, y: 0 }, exportedSlug: null, nodeType: 'gate' as const, agent: { name: 'Gate', description: '', completionCriteria: '' } }
  }
  function agentNode(id: string, name: string) {
    return { id, position: { x: 0, y: 0 }, exportedSlug: null, agent: { name, description: '', completionCriteria: 'done' } }
  }
  function wf(nodes: unknown[], edges: unknown[]) {
    const now = new Date().toISOString()
    return { meta: { id: 'w', name: 'W', description: '', version: 1, created: now, updated: now }, nodes, edges } as never
  }

  it('a gate as entry node is an error', () => {
    const r = validateWorkflow(wf([gateNode('g1'), agentNode('a1', 'A')], [{ id: 'e1', from: 'g1', to: 'a1', trigger: 't' }]))
    expect(r.errors.some(e => e.type === 'gate-entry' && e.nodeId === 'g1')).toBe(true)
  })

  it('two directly adjacent gates are an error', () => {
    const r = validateWorkflow(wf(
      [agentNode('a1', 'A'), gateNode('g1'), gateNode('g2')],
      [{ id: 'e1', from: 'a1', to: 'g1', trigger: 't' }, { id: 'e2', from: 'g1', to: 'g2', trigger: 't' }],
    ))
    expect(r.errors.some(e => e.type === 'gate-adjacent')).toBe(true)
  })

  it('gates are exempt from duplicate-slug and completion-criteria checks', () => {
    const r = validateWorkflow(wf(
      [agentNode('a1', 'Gate'), gateNode('g1'), agentNode('a2', 'B')],
      [{ id: 'e1', from: 'a1', to: 'g1', trigger: 't' }, { id: 'e2', from: 'g1', to: 'a2', trigger: 't' }, { id: 'e3', from: 'a2', to: null, trigger: 'd', terminalType: 'complete' }],
    ))
    expect(r.errors.filter(e => e.type === 'duplicate-slug')).toHaveLength(0)   // agent "Gate" vs gate node: no clash — gates own no slug
    expect(r.warnings.filter(w => w.nodeId === 'g1' && w.type === 'missing-completion-criteria')).toHaveLength(0)
  })
})
