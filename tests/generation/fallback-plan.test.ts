import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { fallbackPlan } from '../../src/generation/fallback-plan.js'

const auto = (steps: string[], over: Partial<DetectedAutomation> = {}): DetectedAutomation => ({
  id: 'a1',
  title: 'T',
  description: 'D',
  steps,
  stepTokens: [],
  evidence: { count: 1, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 1,
  status: 'new',
  ...over,
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

  it('preserves observed fan-out in the deterministic fallback', () => {
    const plan = fallbackPlan(auto(
      ['prepare the inputs', 'review the API', 'independently review the UI', 'summarize the reviews'],
      {
        shape: {
          stepArchetypes: ['prepare', 'review', 'review', 'communicate'],
          distinctArchetypes: 3,
          hasToolActivity: false,
          hasVerifySignal: false,
          hasRetryPattern: false,
          hasRiskyStep: false,
          independentStepGroups: 2,
          independentStepIndexes: [1, 2],
          recurring: false,
        },
      },
    ))

    expect(plan.phases.map(phase => phase.dispatch ?? 'sequential')).toEqual([
      'sequential',
      'parallel',
      'parallel',
      'sequential',
    ])
    expect(plan.phases.flatMap(phase => phase.stepIndexes)).toEqual([0, 1, 2, 3])
  })

  it('serializes ambiguous persisted parallel counts without exact indexes', () => {
    const plan = fallbackPlan(auto(['prepare fixtures', 'review API', 'review UI'], {
      shape: {
        stepArchetypes: ['prepare', 'review', 'review'],
        distinctArchetypes: 2,
        hasToolActivity: true,
        hasVerifySignal: false,
        hasRetryPattern: false,
        hasRiskyStep: false,
        independentStepGroups: 2,
        recurring: false,
      },
    }))

    expect(plan.phases.every(phase => phase.dispatch !== 'parallel')).toBe(true)
  })
})
