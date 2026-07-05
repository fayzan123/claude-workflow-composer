import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { compile } from '../../src/generation/compiler.js'
import type { WorkflowPlan } from '../../src/generation/plan-schema.js'
import { agentSlug } from '../../src/slugify.js'

const auto = (steps: string[], over: Partial<DetectedAutomation> = {}): DetectedAutomation => ({
  id: 'a1',
  title: 'NPM Release',
  description: 'Verify, bump, publish.',
  steps,
  stepTokens: [],
  evidence: { count: 3, repos: ['/repo'], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 1,
  status: 'new',
  ...over,
})
const catalog = { skills: [], agents: [], cards: [] }
const npmPlan: WorkflowPlan = {
  name: 'NPM Release',
  description: 'Verify, bump, publish.',
  phases: [
    { id: 'p1', intent: 'run the test suite', stepIndexes: [0, 1] },
    { id: 'p2', intent: 'bump the version', stepIndexes: [2], archetypeHint: 'prepare' },
    { id: 'p3', intent: 'publish to npm', stepIndexes: [3], archetypeHint: 'publish' },
  ],
}

describe('compile', () => {
  const noRiskDeps = { scanRisk: () => false, resolveReuse: () => ({ attach: false } as const) }
  const cwc = compile({ automation: auto(['run tests', 'lint', 'bump version', 'npm publish']), plan: npmPlan, catalog, triggers: [] }, noRiskDeps)

  it('produces a valid graph: every edge endpoint resolves', () => {
    const ids = new Set(cwc.nodes.map(node => node.id))
    for (const edge of cwc.edges) {
      expect(ids.has(edge.from)).toBe(true)
      if (edge.to !== null) expect(ids.has(edge.to)).toBe(true)
    }
  })

  it('creates one node per phase when risk is explicitly disabled', () => {
    expect(cwc.nodes.filter(node => node.nodeType !== 'gate')).toHaveLength(3)
    expect(cwc.nodes.filter(node => node.nodeType === 'gate')).toHaveLength(0)
  })

  it('assigns each phase the correct steps in its systemPrompt', () => {
    const verify = cwc.nodes[0]
    expect(verify.agent.systemPrompt).toContain('run tests')
    expect(verify.agent.systemPrompt).toContain('lint')
    expect(verify.agent.systemPrompt).not.toContain('npm publish')
  })

  it('gives the publish phase publish-archetype tools and the verify phase verify tools', () => {
    expect(cwc.nodes[0].agent.tools).toEqual(['Bash', 'Read'])
    expect(cwc.nodes[2].agent.tools).toEqual(['Bash'])
  })

  it('ends in a terminal edge', () => {
    expect(cwc.edges.some(edge => edge.to === null && edge.terminalType === 'complete')).toBe(true)
  })

  it('lays nodes out left-to-right stepping by 350', () => {
    expect(cwc.nodes[0].position.x).toBe(0)
    expect(cwc.nodes[1].position.x).toBe(350)
  })

  it('assigns a server UUID and unique node names', () => {
    expect(cwc.meta.id).toMatch(/[0-9a-f-]{36}/)
    const names = cwc.nodes.map(node => node.agent.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('self-heals bespoke phase names whose export slugs collide', () => {
    const healed = compile({
      automation: auto(['run tests', 'run tests again']),
      plan: {
        name: 'x',
        description: '',
        phases: [
          { id: 'p1', intent: 'Run Tests', stepIndexes: [0] },
          { id: 'p2', intent: 'Run Tests.', stepIndexes: [1] },
        ],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)
    const slugs = healed.nodes
      .filter(node => !node.agentRef && node.nodeType !== 'gate')
      .map(node => agentSlug(node.agent.name))
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('falls back to a valid workflow when the plan is garbage', () => {
    const bad = compile({ automation: auto(['run tests', 'npm publish']), plan: { junk: true }, catalog, triggers: [] }, noRiskDeps)
    expect(bad.nodes.length).toBeGreaterThan(0)
    const ids = new Set(bad.nodes.map(node => node.id))
    for (const edge of bad.edges) if (edge.to !== null) expect(ids.has(edge.to)).toBe(true)
  })

  it('inserts a gate before a phase when risk is flagged', () => {
    const gated = compile({
      automation: auto(['run tests', 'npm publish']),
      plan: {
        name: 'x',
        description: '',
        phases: [
          { id: 'p1', intent: 'tests', stepIndexes: [0] },
          { id: 'p2', intent: 'publish', stepIndexes: [1] },
        ],
      },
      catalog,
      triggers: [],
    })
    const gateIdx = gated.nodes.findIndex(node => node.nodeType === 'gate')
    const pubIdx = gated.nodes.findIndex(node => node.agent.name.toLowerCase().includes('publish'))
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeLessThan(pubIdx)
  })

  it('emits a pure skill reference node when reuse attaches a skill', () => {
    const reused = compile(
      {
        automation: auto(['run the full TDD loop']),
        plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: 'tdd', stepIndexes: [0] }] },
        catalog: { skills: [{ slug: 'tdd', description: 'test driven dev' }], agents: [], cards: [] },
        triggers: [],
      },
      { resolveReuse: () => ({ attach: true, kind: 'skill', slug: 'tdd' }), scanRisk: () => false },
    )
    expect(reused.nodes[0].agent.skills).toEqual(['tdd'])
    expect(reused.nodes[0].agentRef).toBeUndefined()
  })

  it('emits an agentRef reference node when reuse attaches an agent', () => {
    const reused = compile(
      {
        automation: auto(['review the code']),
        plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: 'review', stepIndexes: [0] }] },
        catalog: { skills: [], agents: [{ slug: 'security-engineer', name: 'Security Engineer', description: 'sec' }], cards: [] },
        triggers: [],
      },
      { resolveReuse: () => ({ attach: true, kind: 'agent', slug: 'security-engineer' }), scanRisk: () => false },
    )
    expect(reused.nodes[0].agentRef).toBe('security-engineer')
    expect(reused.nodes[0].agent.skills).toEqual([])
    expect(reused.nodes[0].agent.systemPrompt).toBe('')
  })
})
