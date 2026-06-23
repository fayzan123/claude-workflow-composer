import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { generateWorkflow } from '../../src/generation/generate.js'

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
})
