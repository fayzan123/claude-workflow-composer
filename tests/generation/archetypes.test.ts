import { describe, expect, it } from 'vitest'
import { buildCompletionCriteria, buildSystemPrompt, GENERIC, matchArchetype } from '../../src/generation/archetypes.js'

describe('matchArchetype', () => {
  it('honors a hint that the step text supports', () => {
    expect(matchArchetype('publish', 'npm publish the package').id).toBe('publish')
  })

  it('ignores a hint the text contradicts and matches by signal', () => {
    expect(matchArchetype('publish', 'run the test suite and lint').id).toBe('verify')
  })

  it('falls back to generic when nothing matches', () => {
    expect(matchArchetype(undefined, 'xyzzy frobnicate').id).toBe(GENERIC.id)
  })

  it('flags publish/communicate as risky', () => {
    expect(matchArchetype(undefined, 'deploy to vercel').risky).toBe(true)
    expect(matchArchetype(undefined, 'send a slack notification').risky).toBe(true)
    expect(matchArchetype(undefined, 'run tests').risky).toBe(false)
  })
})

describe('prose templates', () => {
  it('builds a checklist systemPrompt grounded in the steps', () => {
    const prompt = buildSystemPrompt({
      automationName: 'A',
      phaseName: 'Verify',
      goal: 'g',
      steps: ['run tests', 'lint'],
      risky: false,
    })
    expect(prompt).toContain('Automation: A')
    expect(prompt).toContain('Phase: Verify')
    expect(prompt).toContain('1. run tests')
    expect(prompt).toContain('2. lint')
    expect(prompt).toContain('Risk policy:')
  })

  it('builds completion criteria naming the phase', () => {
    expect(buildCompletionCriteria('Publish to npm')).toBe('The Publish to npm phase is complete, evidence is summarized, and any files or commands changed by this phase are ready for the next handoff.')
  })
})
