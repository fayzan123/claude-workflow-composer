import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { generateArtifact, generateWorkflow } from '../../src/generation/generate.js'
import { generateOrchestratorBody } from '../../src/workflow/prose-generator.js'

const automation: DetectedAutomation = {
  id: 'a',
  title: 'Release',
  description: 'verify then publish',
  steps: ['run tests', 'npm publish'],
  stepTokens: [],
  evidence: { count: 2, repos: ['/r'], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 1,
  status: 'new',
}

const planJson = JSON.stringify({
  name: 'Release',
  description: 'd',
  phases: [
    { id: 'p1', intent: 'run tests', stepIndexes: [0] },
    { id: 'p2', intent: 'publish to npm', stepIndexes: [1] },
  ],
})

describe('generateWorkflow', () => {
  it('compiles a valid workflow from a good planner response', async () => {
    const cwc = await generateWorkflow({
      automation,
      homeDir: '/nonexistent',
      runner: async () => ({ result: planJson, sessionId: 's' }),
      model: 'm',
    })
    expect(cwc.nodes.length).toBeGreaterThanOrEqual(2)
    expect(cwc.nodes.some(node => node.nodeType === 'gate')).toBe(true)
  })

  it('still yields a valid workflow when the planner returns garbage', async () => {
    const cwc = await generateWorkflow({
      automation,
      homeDir: '/nonexistent',
      runner: async () => ({ result: 'not json at all', sessionId: 's' }),
      model: 'm',
    })
    const ids = new Set(cwc.nodes.map(node => node.id))
    for (const edge of cwc.edges) if (edge.to !== null) expect(ids.has(edge.to)).toBe(true)
    expect(cwc.nodes.length).toBeGreaterThan(0)
  })

  it('preserves observed parallelism when planning fails and joins terminal completion', async () => {
    const cwc = await generateWorkflow({
      automation: {
        ...automation,
        description: 'review API and UI independently',
        steps: ['review the API', 'independently review the UI'],
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
      },
      homeDir: '/nonexistent',
      runner: async () => ({ result: 'not json at all', sessionId: 's' }),
      model: 'm',
    })

    const incoming = new Set(cwc.edges.filter(edge => edge.to !== null).map(edge => edge.to))
    expect(cwc.nodes.filter(node => !incoming.has(node.id))).toHaveLength(2)
    expect(cwc.edges.filter(edge => edge.to === null)).toHaveLength(2)
    const body = generateOrchestratorBody(cwc.nodes, cwc.edges, cwc.meta.name)
    expect(body).toMatch(/in parallel/i)
    expect(body).toMatch(/have all completed, their parallel branches complete the workflow/i)
  })
})

describe('generateArtifact', () => {
  it('does not call a model for a rule', async () => {
    let calls = 0
    const result = await generateArtifact({
      tier: 'rule',
      automation: { ...automation, ruleSuggestion: 'Always run tests before publishing.' },
      homeDir: '/nonexistent',
      runner: async () => { calls++; throw new Error('must not run') },
    })

    expect(result).toEqual({ tier: 'rule', ruleSuggestion: 'Always run tests before publishing.' })
    expect(calls).toBe(0)
  })

  it('never invents a rule from analysis-model fields when grounded prompt evidence is absent', async () => {
    let calls = 0
    await expect(generateArtifact({
      tier: 'rule',
      automation: { ...automation, ruleSuggestion: undefined },
      homeDir: '/nonexistent',
      runner: async () => { calls++; throw new Error('must not run') },
    })).rejects.toThrow(/evidence-grounded rule suggestion/i)
    expect(calls).toBe(0)
  })

  it('falls back within the skill tier and never escalates a runner failure to workflow', async () => {
    const result = await generateArtifact({
      tier: 'skill',
      automation,
      homeDir: '/nonexistent',
      runner: async () => { throw new Error('runner failed') },
    })

    expect(result.tier).toBe('skill')
    if (result.tier !== 'skill') throw new Error('unexpected tier')
    expect(result.fallbackUsed).toBe(true)
    expect(result.cwc.meta.artifactKind).toBe('skill')
    expect(result.cwc.meta.artifactTier).toBe('skill')
    expect(result.cwc.nodes).toHaveLength(1)
    expect(result.cwc.edges).toEqual([])
  })

  it('returns an explicitly tagged workflow only for the workflow branch', async () => {
    const result = await generateArtifact({
      tier: 'workflow',
      automation,
      homeDir: '/nonexistent',
      runner: async () => ({ result: planJson, sessionId: 's' }),
    })

    expect(result.tier).toBe('workflow')
    if (result.tier !== 'workflow') throw new Error('unexpected tier')
    expect(result.cwc.meta.artifactKind).toBe('workflow')
    expect(result.cwc.meta.artifactTier).toBe('workflow')
    expect(result.cwc.meta.sourceAutomation?.steps).toEqual(automation.steps)
  })

  it('rejects an unknown runtime tier instead of falling through to workflow', async () => {
    await expect(generateArtifact({
      tier: 'unknown' as never,
      automation,
      homeDir: '/nonexistent',
      runner: async () => ({ result: planJson, sessionId: 's' }),
    })).rejects.toThrow(/unsupported artifact tier/i)
  })
})
