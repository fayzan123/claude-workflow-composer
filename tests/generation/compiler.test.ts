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
    expect(cwc.meta).toMatchObject({ version: 2, artifactKind: 'workflow', artifactTier: 'workflow' })
    expect(cwc.meta.sourceAutomation?.steps).toEqual(['run tests', 'lint', 'bump version', 'npm publish'])
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

  it('falls back when a structurally valid planner result omits observed steps', () => {
    const bad = compile({
      automation: auto(['run tests', 'npm publish']),
      plan: {
        name: 'Incomplete planner result',
        description: 'Missing the publish step.',
        phases: [{ id: 'p1', intent: 'tests', stepIndexes: [0] }],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)

    expect(bad.meta.name).toBe('NPM Release')
    expect(bad.nodes.some(node => node.agent.systemPrompt.includes('npm publish'))).toBe(true)
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

  it.each([
    ['skill', 'send a message to Slack'],
    ['agent', 'post the release announcement'],
  ] as const)('keeps a gate before a risky reused %s phase', (kind, step) => {
    const reused = compile(
      {
        automation: auto([step]),
        plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: step, stepIndexes: [0] }] },
        catalog: kind === 'skill'
          ? { skills: [{ slug: 'publisher', description: 'publishes' }], agents: [], cards: [] }
          : { skills: [], agents: [{ slug: 'publisher', name: 'Publisher', description: 'publishes' }], cards: [] },
        triggers: [],
      },
      { resolveReuse: () => ({ attach: true, kind, slug: 'publisher' }) },
    )

    const gateIndex = reused.nodes.findIndex(node => node.nodeType === 'gate')
    const reusedIndex = reused.nodes.findIndex(node => kind === 'agent' ? node.agentRef === 'publisher' : node.agent.skills?.includes('publisher'))
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeLessThan(reusedIndex)
  })

  it('guards the workflow at entry when only grounded prompt or command evidence reveals risk', () => {
    const guarded = compile({
      automation: auto(['finish the routine'], {
        shape: {
          stepArchetypes: ['generic'],
          distinctArchetypes: 0,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: true,
          independentStepGroups: 1,
          recurring: false,
        },
      }),
      plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: 'finish the routine', stepIndexes: [0] }] },
      catalog,
      triggers: [],
    })

    expect(guarded.nodes.map(node => node.nodeType ?? 'agent')).toEqual(['agent', 'gate', 'agent'])
    expect(guarded.nodes[0].agent.name).toMatch(/preflight/i)
  })

  it('preserves an exact observed connector tool only on its approval-gated agent', () => {
    const tool = 'mcp__slack__send_message'
    const guarded = compile({
      automation: auto(['finish the routine'], {
        shape: {
          stepArchetypes: ['generic'],
          distinctArchetypes: 0,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: true,
          independentStepGroups: 1,
          recurring: false,
          observedMutatingTools: [tool],
        },
      }),
      plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: 'finish the routine', stepIndexes: [0] }] },
      catalog,
      triggers: [],
    })

    expect(guarded.nodes.map(node => node.nodeType ?? 'agent')).toEqual(['agent', 'gate', 'agent'])
    expect(guarded.nodes[0].agent.tools).toEqual(['Read'])
    expect(guarded.nodes[2].agent.tools).toContain(tool)
    expect(guarded.nodes[2].agent.systemPrompt).toContain(`\`${tool}\``)
  })

  it('delays a connector tool to the specifically matched later approval phase', () => {
    const tool = 'mcp__vercel__deploy_production'
    const guarded = compile({
      automation: auto(['Publish the build to staging', 'Deploy the build to production'], {
        shape: {
          stepArchetypes: ['publish', 'publish'],
          distinctArchetypes: 1,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: true,
          independentStepGroups: 1,
          recurring: false,
          observedMutatingTools: [tool],
        },
      }),
      plan: {
        name: 'x',
        description: '',
        phases: [
          { id: 'p1', intent: 'publish staging', stepIndexes: [0] },
          { id: 'p2', intent: 'deploy production', stepIndexes: [1] },
        ],
      },
      catalog,
      triggers: [],
    })

    const agents = guarded.nodes.filter(node => node.nodeType !== 'gate')
    expect(agents.slice(0, -1).every(node => !node.agent.tools?.includes(tool))).toBe(true)
    expect(agents.at(-1)?.agent.tools).toContain(tool)
    const targetIndex = guarded.nodes.findIndex(node => node.agent.tools?.includes(tool))
    expect(guarded.nodes.slice(0, targetIndex).some(node => node.nodeType === 'gate')).toBe(true)
  })

  it('does not attach a reference agent when the phase needs an observed connector allowlist', () => {
    const guarded = compile(
      {
        automation: auto(['Send the Slack message'], {
          shape: {
            stepArchetypes: ['communicate'],
            distinctArchetypes: 1,
            hasToolActivity: true,
            hasVerifySignal: false,
            hasRetryPattern: false,
            hasRiskyStep: true,
            independentStepGroups: 1,
            recurring: false,
            observedMutatingTools: ['mcp__slack__send_message'],
          },
        }),
        plan: { name: 'x', description: '', phases: [{ id: 'p1', intent: 'send Slack message', stepIndexes: [0] }] },
        catalog: { skills: [], agents: [{ slug: 'publisher', name: 'Publisher', description: 'publishes' }], cards: [] },
        triggers: [],
      },
      { resolveReuse: () => ({ attach: true, kind: 'agent', slug: 'publisher' }) },
    )

    const runnable = guarded.nodes.find(node => node.nodeType !== 'gate' && node.agent.name !== 'Preflight Review')
    expect(runnable?.agentRef).toBeUndefined()
    expect(runnable?.agent.tools).toContain('mcp__slack__send_message')
  })

  it('compiles consecutive parallel phases as sibling entry branches', () => {
    const parallel = compile({
      automation: auto(['review API', 'review UI'], {
        shape: {
          stepArchetypes: ['review', 'review'],
          distinctArchetypes: 1,
          hasToolActivity: false,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 2,
          independentStepIndexes: [0, 1],
          recurring: false,
        },
      }),
      plan: {
        name: 'Parallel review',
        description: '',
        phases: [
          { id: 'p1', intent: 'review API', stepIndexes: [0], dispatch: 'parallel' },
          { id: 'p2', intent: 'review UI', stepIndexes: [1], dispatch: 'parallel' },
        ],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)

    expect(parallel.nodes.map(node => node.id)).toEqual(['node-p1', 'node-p2'])
    expect(parallel.nodes[0].position.x).toBe(parallel.nodes[1].position.x)
    expect(parallel.nodes[0].position.y).not.toBe(parallel.nodes[1].position.y)
    expect(parallel.edges.some(edge => edge.from === 'node-p1' && edge.to === 'node-p2')).toBe(false)
    expect(parallel.edges.filter(edge => edge.to === null)).toHaveLength(2)
  })

  it('fans out after prerequisites and joins once before follow-up work', () => {
    const parallel = compile({
      automation: auto(['prepare', 'review API', 'review UI', 'summarize'], {
        shape: {
          stepArchetypes: ['prepare', 'review', 'review', 'communicate'],
          distinctArchetypes: 3,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 2,
          independentStepIndexes: [1, 2],
          recurring: false,
        },
      }),
      plan: {
        name: 'Parallel review',
        description: '',
        phases: [
          { id: 'p1', intent: 'prepare', stepIndexes: [0] },
          { id: 'p2', intent: 'review API', stepIndexes: [1], dispatch: 'parallel' },
          { id: 'p3', intent: 'review UI', stepIndexes: [2], dispatch: 'parallel' },
          { id: 'p4', intent: 'summarize', stepIndexes: [3] },
        ],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)

    expect(parallel.nodes.find(node => node.id === 'node-p1')?.dispatchMode).toBe('parallel')
    expect(parallel.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'node-p1', to: 'node-p2' }),
      expect.objectContaining({ from: 'node-p1', to: 'node-p3' }),
      expect.objectContaining({ from: 'node-p2', to: 'node-p4' }),
      expect.objectContaining({ from: 'node-p3', to: 'node-p4' }),
    ]))
    expect(parallel.edges.filter(edge => edge.to === null)).toHaveLength(1)
  })

  it('uses one shared approval boundary for a risky parallel fan-out', () => {
    const guarded = compile({
      automation: auto(['review the frontend', 'deploy the backend in parallel'], {
        shape: {
          stepArchetypes: ['review', 'publish'],
          distinctArchetypes: 2,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: true,
          independentStepGroups: 2,
          independentStepIndexes: [0, 1],
          recurring: false,
        },
      }),
      plan: {
        name: 'Parallel release',
        description: '',
        phases: [
          { id: 'p1', intent: 'review frontend', stepIndexes: [0], dispatch: 'parallel' },
          { id: 'p2', intent: 'deploy backend', stepIndexes: [1], dispatch: 'parallel' },
        ],
      },
      catalog,
      triggers: [],
    })

    const gates = guarded.nodes.filter(node => node.nodeType === 'gate')
    expect(gates).toHaveLength(1)
    const gate = gates[0]
    expect(guarded.nodes.find(node => node.id === gate.id)?.dispatchMode).toBe('parallel')
    expect(guarded.edges.filter(edge => edge.from === gate.id).map(edge => edge.to)).toEqual([
      'node-p1',
      'node-p2',
    ])
    expect(guarded.nodes.filter(node => node.agent.name.includes('Preflight'))).toHaveLength(1)
  })

  it('rejects planner-invented parallel dispatch for a legacy automation with no shape', () => {
    const logs: string[] = []
    const compiled = compile({
      automation: auto(['build the feature', 'review the result']),
      plan: {
        name: 'Ungrounded parallel',
        description: '',
        phases: [
          { id: 'p1', intent: 'build the feature', stepIndexes: [0], dispatch: 'parallel' },
          { id: 'p2', intent: 'review the result', stepIndexes: [1], dispatch: 'parallel' },
        ],
      },
      catalog,
      triggers: [],
      onLog: message => logs.push(message),
    }, noRiskDeps)

    // No grounded sibling evidence exists, so the phases must compile serially.
    expect(compiled.edges.filter(edge => edge.to === null)).toHaveLength(1)
    expect(logs).toContain('Planner output invented parallel dispatch without grounded sibling evidence; using the deterministic fallback plan.')
  })

  it('rejects a sequential planner result when observed evidence requires fan-out', () => {
    const logs: string[] = []
    const parallel = compile({
      automation: auto(['review API', 'independently review UI'], {
        shape: {
          stepArchetypes: ['review', 'review'],
          distinctArchetypes: 1,
          hasToolActivity: false,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 2,
          independentStepIndexes: [0, 1],
          recurring: false,
        },
      }),
      plan: {
        name: 'Incorrect serial review',
        description: '',
        phases: [
          { id: 'p1', intent: 'review API', stepIndexes: [0] },
          { id: 'p2', intent: 'review UI', stepIndexes: [1] },
        ],
      },
      catalog,
      triggers: [],
      onLog: message => logs.push(message),
    }, noRiskDeps)

    expect(parallel.edges.some(edge => edge.from === 'node-p1' && edge.to === 'node-p2')).toBe(false)
    expect(parallel.edges.filter(edge => edge.to === null)).toHaveLength(2)
    expect(logs).toContain('Planner output omitted the observed parallel fan-out; using the deterministic parallel fallback plan.')
  })

  it('requires the planner fan-out to cover every observed independent group', () => {
    const parallel = compile({
      automation: auto(['review API in parallel', 'review UI in parallel', 'review CLI in parallel'], {
        shape: {
          stepArchetypes: ['review', 'review', 'review'],
          distinctArchetypes: 1,
          hasToolActivity: false,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 3,
          independentStepIndexes: [0, 1, 2],
          recurring: false,
        },
      }),
      plan: {
        name: 'Incomplete fan-out',
        description: '',
        phases: [
          { id: 'p1', intent: 'review API', stepIndexes: [0], dispatch: 'parallel' },
          { id: 'p2', intent: 'review UI', stepIndexes: [1], dispatch: 'parallel' },
          { id: 'p3', intent: 'review CLI', stepIndexes: [2] },
        ],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)

    expect(parallel.edges.filter(edge => edge.to === null)).toHaveLength(3)
    expect(parallel.nodes.map(node => node.position.x)).toEqual([0, 0, 0])
  })

  it('rejects a planner fan-out at the wrong observed step indexes', () => {
    const parallel = compile({
      automation: auto(['prepare fixtures', 'review API', 'review UI', 'summarize'], {
        shape: {
          stepArchetypes: ['prepare', 'review', 'review', 'communicate'],
          distinctArchetypes: 3,
          hasToolActivity: true,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 2,
          independentStepIndexes: [1, 2],
          recurring: false,
        },
      }),
      plan: {
        name: 'Wrong fan-out',
        description: '',
        phases: [
          { id: 'p1', intent: 'prepare fixtures', stepIndexes: [0], dispatch: 'parallel' },
          { id: 'p2', intent: 'review API', stepIndexes: [1], dispatch: 'parallel' },
          { id: 'p3', intent: 'review UI', stepIndexes: [2] },
          { id: 'p4', intent: 'summarize', stepIndexes: [3] },
        ],
      },
      catalog,
      triggers: [],
    }, noRiskDeps)

    expect(parallel.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'node-p1', to: 'node-p2' }),
      expect.objectContaining({ from: 'node-p1', to: 'node-p3' }),
      expect.objectContaining({ from: 'node-p2', to: 'node-p4' }),
      expect.objectContaining({ from: 'node-p3', to: 'node-p4' }),
    ]))
    expect(parallel.edges.some(edge => edge.from === 'node-p1' && edge.to === 'node-p4')).toBe(false)
  })
})
