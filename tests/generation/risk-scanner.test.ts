import { describe, expect, it } from 'vitest'
import type { DetectedAutomation } from '../../src/detection/types.js'
import type { PlanPhase } from '../../src/generation/plan-schema.js'
import { scanRisk } from '../../src/generation/risk-scanner.js'

const auto = (steps: string[]): DetectedAutomation => ({
  id: 'a',
  title: 't',
  description: 'd',
  steps,
  stepTokens: [],
  evidence: { count: 1, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'm' },
  confidence: 1,
  status: 'new',
})
const phase = (over: Partial<PlanPhase>): PlanPhase => ({ id: 'p1', intent: '', stepIndexes: [0], ...over })

describe('scanRisk', () => {
  it('gates npm publish', () => {
    expect(scanRisk(phase({ intent: 'publish to npm', stepIndexes: [0] }), auto(['npm publish']))).toBe(true)
  })

  it('gates git push to production', () => {
    expect(scanRisk(phase({ intent: 'deploy', stepIndexes: [0] }), auto(['git push origin main', 'deploy to vercel']))).toBe(true)
  })

  it('does NOT gate a production build', () => {
    expect(scanRisk(phase({ intent: 'create a production build', stepIndexes: [0] }), auto(['run the production build']))).toBe(false)
  })

  it('does NOT gate test/lint/typecheck', () => {
    expect(scanRisk(phase({ intent: 'verify', stepIndexes: [0] }), auto(['run tests', 'lint', 'typecheck']))).toBe(false)
  })

  it('unions the planner riskHint', () => {
    expect(scanRisk(phase({ intent: 'do the thing', stepIndexes: [0], riskHint: ['charge'] }), auto(['do the thing']))).toBe(true)
  })
})
