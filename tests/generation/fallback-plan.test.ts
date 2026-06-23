import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { fallbackPlan } from '../../src/generation/fallback-plan.js'

const auto = (steps: string[]): DetectedAutomation => ({
  id: 'a1',
  title: 'T',
  description: 'D',
  steps,
  stepTokens: [],
  evidence: { count: 1, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 1,
  status: 'new',
})

describe('fallbackPlan', () => {
  it('returns a valid plan covering every step exactly once', () => {
    const plan = fallbackPlan(auto(['run tests', 'lint code', 'bump version', 'npm publish']))
    const covered = plan.phases.flatMap(phase => phase.stepIndexes).sort((a, b) => a - b)
    expect(covered).toEqual([0, 1, 2, 3])
  })

  it('groups consecutive same-archetype steps and splits at archetype boundary', () => {
    const plan = fallbackPlan(auto(['run tests', 'lint code', 'npm publish']))
    expect(plan.phases).toHaveLength(2)
    expect(plan.phases[0].stepIndexes).toEqual([0, 1])
    expect(plan.phases[1].stepIndexes).toEqual([2])
    expect(plan.phases[1].archetypeHint).toBe('publish')
  })

  it('handles a stepless automation with one generic phase', () => {
    const plan = fallbackPlan(auto([]))
    expect(plan.phases).toHaveLength(1)
    expect(plan.phases[0].stepIndexes).toEqual([0])
  })
})
