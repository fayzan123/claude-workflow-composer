import { describe, it, expect } from 'vitest'
import { buildAnalysisPrompt } from '../../src/detection/analysis-prompt.js'

describe('buildAnalysisPrompt', () => {
  it('embeds the digest lines and asks for an automations object with refs', () => {
    const prompt = buildAnalysisPrompt([
      { repo: '/repo', lines: [{ ref: 'r0', unit: {} as never, text: '[r0] 2026-06-14 09:00 · "fix flaky test" · Bash · tests' }] },
    ])
    expect(prompt).toContain('[r0]')
    expect(prompt).toContain('/repo')
    expect(prompt).toContain('"automations"')
    expect(prompt).toContain('"refs"')
    expect(prompt).toContain('stepTokens')
  })
})
