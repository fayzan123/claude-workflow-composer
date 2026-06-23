import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { compile } from '../../src/generation/compiler.js'

const auto = (steps: string[], over: Partial<DetectedAutomation> = {}): DetectedAutomation => ({
  id: 'a1',
  title: 'NPM Release',
  description: 'd',
  steps,
  stepTokens: [],
  evidence: { count: 3, repos: ['/r'], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 1,
  status: 'new',
  ...over,
})

describe('compile with real reuse + risk deps', () => {
  it('gates the publish phase deterministically', () => {
    const cwc = compile({
      automation: auto(['run tests', 'bump version', 'npm publish']),
      plan: {
        name: 'NPM Release',
        description: 'd',
        phases: [
          { id: 'p1', intent: 'run tests', stepIndexes: [0] },
          { id: 'p2', intent: 'bump version', stepIndexes: [1] },
          { id: 'p3', intent: 'publish to npm', stepIndexes: [2] },
        ],
      },
      catalog: { skills: [], agents: [], cards: [] },
      triggers: [],
    })
    const gateIdx = cwc.nodes.findIndex(node => node.nodeType === 'gate')
    const pubIdx = cwc.nodes.findIndex(node => node.agent.name.toLowerCase().includes('publish'))
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeLessThan(pubIdx)
  })

  it('never starts the workflow with a gate when the first phase is risky', () => {
    const cwc = compile({
      automation: auto(['commit and push to main', 'publish to npm']),
      plan: {
        name: 'x',
        description: 'd',
        phases: [
          { id: 'p1', intent: 'commit and push to main', stepIndexes: [0] },
          { id: 'p2', intent: 'publish to npm', stepIndexes: [1] },
        ],
      },
      catalog: { skills: [], agents: [], cards: [] },
      triggers: [],
    })
    // The entry node is the one with no incoming edge — it must be an agent, never a gate.
    const targets = new Set(cwc.edges.filter(e => e.to !== null).map(e => e.to))
    const entries = cwc.nodes.filter(node => !targets.has(node.id))
    expect(entries).toHaveLength(1)
    expect(entries[0].nodeType ?? 'agent').toBe('agent')
    expect(entries[0].startTrigger).toBeTruthy()
    // The publish phase still gets its gate (a gate between two agents is valid).
    expect(cwc.nodes.some(node => node.nodeType === 'gate')).toBe(true)
  })

  it('rejects a broad skill that would collapse the automation, keeping bespoke nodes', () => {
    const logs: string[] = []
    const cwc = compile({
      automation: auto(['research the firm', 'rebrand the site', 'deploy to vercel']),
      plan: {
        name: 'x',
        description: 'd',
        phases: [
          {
            id: 'p1',
            intent: 'do the whole thing',
            stepIndexes: [0, 1, 2],
            reuse: { kind: 'skill', slug: 'design-system', coversStepIndexes: [0, 1, 2], why: 'covers all' },
          },
          { id: 'p2', intent: 'deploy', stepIndexes: [2] },
        ],
      },
      catalog: { skills: [{ slug: 'design-system', description: 'generate a design system' }], agents: [], cards: [] },
      triggers: [],
      onLog: message => logs.push(message),
    })
    expect(cwc.nodes.every(node => !node.agent.skills?.includes('design-system'))).toBe(true)
    expect(logs.some(log => /demoted to bespoke/i.test(log))).toBe(true)
  })
})
