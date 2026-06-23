import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { buildPlannerPrompt } from '../../src/generation/planner-prompt.js'

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

describe('buildPlannerPrompt', () => {
  const prompt = buildPlannerPrompt(automation, { skills: [{ slug: 'tdd', description: 'tdd loop' }], agents: [], cards: [] })

  it('numbers the observed steps from 0', () => {
    expect(prompt).toMatch(/0[).:]\s*run tests/)
    expect(prompt).toMatch(/1[).:]\s*npm publish/)
  })

  it('lists reuse candidate slugs', () => {
    expect(prompt).toContain('tdd')
  })

  it('asks for WorkflowPlan JSON only and forbids systemPrompts', () => {
    expect(prompt.toLowerCase()).toContain('phases')
    expect(prompt.toLowerCase()).toMatch(/json only|only.*json/)
    expect(prompt.toLowerCase()).toContain('stepindexes')
    expect(prompt.toLowerCase()).toContain('do not write systemprompts')
  })

  it('steers toward the fewest phases and risk-boundary grouping (anti over-decomposition)', () => {
    const lower = prompt.toLowerCase()
    expect(lower).toContain('fewest phases')
    expect(lower).toMatch(/one phase|fewer, more capable/)
    expect(lower).toContain('risk boundary')
  })
})
