import { describe, expect, it } from 'vitest'
import { classifyAutomation, classifyAutomationWithReason } from '../../src/generation/classifier.js'
import type { AutomationShape, DetectedAutomation } from '../../src/detection/types.js'

const baseShape: AutomationShape = {
  stepArchetypes: ['implement'],
  distinctArchetypes: 1,
  hasToolActivity: true,
  hasVerifySignal: false,
  hasRetryPattern: false,
  hasRiskyStep: false,
  independentStepGroups: 1,
  recurring: false,
}

function automation(shape: AutomationShape | undefined, over: Partial<DetectedAutomation> = {}): DetectedAutomation {
  return {
    id: 'a1',
    title: 'Do work',
    description: 'Do repeated work.',
    steps: shape?.stepArchetypes.map((_, i) => `step ${i + 1}`) ?? ['step 1'],
    stepTokens: ['do-work'],
    evidence: { count: 3, repos: ['/repo'], sessionIds: [], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: 'manual' },
    confidence: 0.9,
    status: 'new',
    ...(shape ? { shape } : {}),
    ...over,
  }
}

describe('classifyAutomation', () => {
  it('keeps pre-shape scan records on the legacy workflow path', () => {
    expect(classifyAutomation(automation(undefined))).toBe('workflow')
  })

  it('classifies repeated prompt-only instructions as rules', () => {
    expect(classifyAutomation(automation({ ...baseShape, hasToolActivity: false }))).toBe('rule')
  })

  it('reserves workflows for grounded parallel independence', () => {
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['review', 'review'],
      independentStepGroups: 2,
      independentStepIndexes: [0, 1],
    }))).toBe('workflow')
  })

  it('does not treat verb variety in a linear checklist as multi-role evidence', () => {
    // "read spec → run tests → fix gaps" is one person's linear procedure: a skill.
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['review', 'implement', 'verify'],
      distinctArchetypes: 3,
      hasVerifySignal: true,
    }))).toBe('skill')
  })

  it('keeps hard external actions (and legacy risky shapes) in a gate-capable workflow', () => {
    const hard = { ...baseShape, stepArchetypes: ['publish'], hasRiskyStep: true, hasHardRiskyStep: true }
    expect(classifyAutomation(automation(hard))).toBe('workflow')
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['communicate'],
      hasToolActivity: false,
      hasRiskyStep: true,
      hasHardRiskyStep: true,
    }))).toBe('workflow')
    // Legacy shape without the hard/soft split classifies conservatively as hard.
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['publish'],
      hasRiskyStep: true,
    }))).toBe('workflow')
  })

  it('keeps soft VCS collaboration (commit/push/PR) on the smaller tiers', () => {
    // "stage → commit → push" is the canonical daily slash command, not a workflow.
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['review', 'publish'],
      distinctArchetypes: 2,
      hasRiskyStep: true,
      hasHardRiskyStep: false,
    }))).toBe('skill')
    // Verification with retries plus soft push risk is still a loop, not a workflow.
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['verify', 'publish'],
      distinctArchetypes: 2,
      hasVerifySignal: true,
      hasRetryPattern: true,
      hasRiskyStep: true,
      hasHardRiskyStep: false,
    }))).toBe('loop')
  })

  it('routes command-driven repetitions to a rule naming the installed command', () => {
    expect(classifyAutomation(automation({
      ...baseShape,
      invokedSlashCommand: 'brutal-product-analysis',
    }))).toBe('rule')
    // Even risky evidence: the installed command already encapsulates the action.
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['publish'],
      hasRiskyStep: true,
      hasHardRiskyStep: true,
      invokedSlashCommand: 'ship',
    }))).toBe('rule')
  })

  it('classifies recurrence and verify-fix-retry procedures as loops', () => {
    expect(classifyAutomation(automation({ ...baseShape, recurring: true }))).toBe('loop')
    expect(classifyAutomation(automation({ ...baseShape, hasVerifySignal: true, hasRetryPattern: true }))).toBe('loop')
  })

  it('defaults linear procedural work to a skill', () => {
    expect(classifyAutomation(automation(baseShape))).toBe('skill')
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['review', 'implement'],
      distinctArchetypes: 2,
    }))).toBe('skill')
  })

  it('explains every recommendation with evidence-specific language', () => {
    expect(classifyAutomationWithReason(automation(undefined)).reason).toContain('predates shape analysis')
    expect(classifyAutomationWithReason(automation({ ...baseShape, invokedSlashCommand: 'ship' })).reason).toContain('/ship')
    expect(classifyAutomationWithReason(automation({
      ...baseShape, stepArchetypes: ['publish'], hasRiskyStep: true, hasHardRiskyStep: true,
    })).reason).toContain('irreversible external action')
    expect(classifyAutomationWithReason(automation({ ...baseShape, recurring: true })).reason).toContain('schedule')
    expect(classifyAutomationWithReason(automation({
      ...baseShape, hasVerifySignal: true, hasRetryPattern: true,
    })).reason).toContain('verify-fix-retry')
    expect(classifyAutomationWithReason(automation(baseShape)).reason).toContain('linear single-role')
    // The wrapper stays consistent with the reasoned recommendation.
    expect(classifyAutomation(automation(baseShape))).toBe(classifyAutomationWithReason(automation(baseShape)).tier)
  })

  it('treats malformed persisted shape as legacy workflow rather than throwing or silently shrinking', () => {
    const malformed = automation({ ...baseShape, distinctArchetypes: 9 })
    expect(classifyAutomation(malformed)).toBe('workflow')
    const hiddenRisk = automation({ ...baseShape, stepArchetypes: ['publish'], hasRiskyStep: false })
    expect(classifyAutomation(hiddenRisk)).toBe('workflow')
    const unsafeTool = automation({
      ...baseShape,
      hasRiskyStep: true,
      observedMutatingTools: ['mcp__slack__send_message, Bash'],
    })
    expect(classifyAutomation(unsafeTool)).toBe('workflow')
    const contradictoryHard = automation({ ...baseShape, hasRiskyStep: false, hasHardRiskyStep: true })
    expect(classifyAutomation(contradictoryHard)).toBe('workflow')
    const forgedCommand = automation({ ...baseShape, invokedSlashCommand: 'Bad Name!' })
    expect(classifyAutomation(forgedCommand)).toBe('workflow')
    expect(classifyAutomation(automation({
      ...baseShape,
      stepArchetypes: ['review', 'review'],
      independentStepGroups: 2,
    }))).toBe('workflow')
  })
})
