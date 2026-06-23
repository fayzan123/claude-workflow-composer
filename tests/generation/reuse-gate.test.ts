import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import type { PlanPhase, WorkflowPlan } from '../../src/generation/plan-schema.js'
import { CAPABILITY_THRESHOLD, capabilityScore, resolveReuse, shapeCheck } from '../../src/generation/reuse-gate.js'

const auto = (steps: string[]): DetectedAutomation => ({
  id: 'a1',
  title: 'T',
  description: 'D',
  steps,
  stepTokens: [],
  evidence: { count: 1, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'm' },
  confidence: 1,
  status: 'new',
})

describe('shapeCheck', () => {
  const plan = (phases: PlanPhase[]): WorkflowPlan => ({ name: 'n', description: '', phases })

  it('rejects a single reuse that collapses a multi-phase automation', () => {
    const phase: PlanPhase = {
      id: 'p1',
      intent: 'x',
      stepIndexes: [0, 1, 2],
      reuse: { kind: 'skill', slug: 's', coversStepIndexes: [0, 1, 2], why: '' },
    }
    expect(shapeCheck(phase, plan([phase, { id: 'p2', intent: 'y', stepIndexes: [0] }]), 3)).toBe(false)
  })

  it('accepts a reuse that covers only its phase steps', () => {
    const phase: PlanPhase = {
      id: 'p1',
      intent: 'x',
      stepIndexes: [0],
      reuse: { kind: 'skill', slug: 's', coversStepIndexes: [0], why: '' },
    }
    expect(shapeCheck(phase, plan([phase, { id: 'p2', intent: 'y', stepIndexes: [1] }]), 2)).toBe(true)
  })

  it('rejects a phase with no reuse', () => {
    const phase: PlanPhase = { id: 'p1', intent: 'x', stepIndexes: [0] }
    expect(shapeCheck(phase, plan([phase]), 1)).toBe(false)
  })
})

describe('capabilityScore', () => {
  it('scores a true fit high', () => {
    const score = capabilityScore('run the full test driven development loop', undefined, 'test driven development workflow with red green refactor')
    expect(score).toBeGreaterThan(CAPABILITY_THRESHOLD)
  })

  it('scores an unrelated broad skill low', () => {
    const score = capabilityScore('run the test suite', undefined, 'generate a complete design system with colors typography and spacing')
    expect(score).toBeLessThan(CAPABILITY_THRESHOLD)
  })
})

describe('resolveReuse fail-safe', () => {
  it('demotes to bespoke when the slug is not in the catalog', () => {
    const phase: PlanPhase = {
      id: 'p1',
      intent: 'run tests',
      stepIndexes: [0],
      reuse: { kind: 'skill', slug: 'ghost', coversStepIndexes: [0], why: '' },
    }
    const decision = resolveReuse(phase, auto(['run tests']), { skills: [], agents: [], cards: [] }, { name: 'n', description: '', phases: [phase] })
    expect(decision.attach).toBe(false)
  })

  it('attaches a real, well-fitting skill', () => {
    const phase: PlanPhase = {
      id: 'p1',
      intent: 'run the full tdd loop',
      stepIndexes: [0],
      reuse: { kind: 'skill', slug: 'tdd', coversStepIndexes: [0], why: '' },
    }
    const decision = resolveReuse(
      phase,
      auto(['run the full tdd loop', 'ship']),
      { skills: [{ slug: 'tdd', description: 'run the full tdd loop with test driven development red green refactor' }], agents: [], cards: [] },
      { name: 'n', description: '', phases: [phase, { id: 'p2', intent: 'ship', stepIndexes: [1] }] },
    )
    expect(decision).toEqual({ attach: true, kind: 'skill', slug: 'tdd' })
  })
})
