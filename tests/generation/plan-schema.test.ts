import { describe, it, expect } from 'vitest'
import { validatePlan } from '../../src/generation/plan-schema.js'

const valid = {
  name: 'NPM Release',
  description: 'Verify, bump, publish.',
  phases: [
    { id: 'p1', intent: 'run the test suite', stepIndexes: [0, 1] },
    { id: 'p2', intent: 'publish to npm', stepIndexes: [2], archetypeHint: 'publish', riskHint: ['publish'] },
  ],
}

describe('validatePlan', () => {
  it('accepts a well-formed plan and returns it typed', () => {
    const p = validatePlan(valid, 3)
    expect(p).not.toBeNull()
    expect(p!.phases).toHaveLength(2)
    expect(p!.phases[1].stepIndexes).toEqual([2])
  })

  it('rejects null/non-object', () => {
    expect(validatePlan(null, 3)).toBeNull()
    expect(validatePlan('nope', 3)).toBeNull()
    expect(validatePlan({}, 3)).toBeNull()
  })

  it('rejects missing or empty phases', () => {
    expect(validatePlan({ name: 'x', description: 'y', phases: [] }, 3)).toBeNull()
    expect(validatePlan({ name: 'x', description: 'y' }, 3)).toBeNull()
  })

  it('rejects a phase whose stepIndexes are out of range or non-integer', () => {
    const bad = { ...valid, phases: [{ id: 'p1', intent: 'x', stepIndexes: [0, 9] }] }
    expect(validatePlan(bad, 3)).toBeNull()
    const frac = { ...valid, phases: [{ id: 'p1', intent: 'x', stepIndexes: [0.5] }] }
    expect(validatePlan(frac, 3)).toBeNull()
  })

  it('rejects a phase missing id or intent', () => {
    expect(validatePlan({ ...valid, phases: [{ intent: 'x', stepIndexes: [0] }] }, 3)).toBeNull()
    expect(validatePlan({ ...valid, phases: [{ id: 'p1', stepIndexes: [0] }] }, 3)).toBeNull()
  })

  it('rejects duplicate phase ids', () => {
    const duplicateIds = {
      ...valid,
      phases: [
        { id: 'p1', intent: 'first', stepIndexes: [0, 1] },
        { id: 'p1', intent: 'second', stepIndexes: [2] },
      ],
    }
    expect(validatePlan(duplicateIds, 3)).toBeNull()
  })

  it('requires every observed step to be covered exactly once', () => {
    const missingStep = {
      ...valid,
      phases: [
        { id: 'p1', intent: 'first', stepIndexes: [0] },
        { id: 'p2', intent: 'second', stepIndexes: [2] },
      ],
    }
    const duplicateStep = {
      ...valid,
      phases: [
        { id: 'p1', intent: 'first', stepIndexes: [0, 1] },
        { id: 'p2', intent: 'second', stepIndexes: [1, 2] },
      ],
    }
    expect(validatePlan(missingStep, 3)).toBeNull()
    expect(validatePlan(duplicateStep, 3)).toBeNull()
  })

  it('drops a malformed reuse but keeps the phase', () => {
    const p = validatePlan({ ...valid, phases: [{ id: 'p1', intent: 'x', stepIndexes: [0, 1, 2], reuse: { kind: 'skill' } }] }, 3)
    expect(p).not.toBeNull()
    expect(p!.phases[0].reuse).toBeUndefined()
  })

  it('keeps a well-formed reuse', () => {
    const complete = validatePlan({
      ...valid,
      phases: [
        { id: 'p1', intent: 'x', stepIndexes: [0, 1], reuse: { kind: 'skill', slug: 'tdd', coversStepIndexes: [0], why: 'fits' } },
        { id: 'p2', intent: 'y', stepIndexes: [2] },
      ],
    }, 3)
    expect(complete!.phases[0].reuse?.slug).toBe('tdd')
  })

  it('rejects reuse coverage outside its phase steps', () => {
    const outsidePhase = {
      ...valid,
      phases: [
        { id: 'p1', intent: 'x', stepIndexes: [0], reuse: { kind: 'skill', slug: 'tdd', coversStepIndexes: [0, 1], why: 'fits' } },
        { id: 'p2', intent: 'y', stepIndexes: [1, 2] },
      ],
    }
    expect(validatePlan(outsidePhase, 3)).toBeNull()
  })
})
