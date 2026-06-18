import { describe, it, expect } from 'vitest'
import { buildWorkflowGenPrompt, parseWorkflowJson } from '../src/workflow-generator.js'
import type { DetectedAutomation } from '../src/detection/types.js'

const auto: DetectedAutomation = {
  id: 'id1', title: 'Triage flaky tests', description: 'rerun and commit fixes', steps: ['run tests', 'commit'],
  stepTokens: ['run-tests', 'commit'], evidence: { count: 4, repos: ['/repo'], sessionIds: ['s'], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9, status: 'new',
}

describe('workflow-generator', () => {
  it('builds a prompt that names the automation and demands the .cwc schema', () => {
    const p = buildWorkflowGenPrompt(auto)
    expect(p).toContain('Triage flaky tests')
    expect(p).toContain('"nodes"')
    expect(p).toContain('exportedSlug')
  })

  it('parses a valid workflow JSON object and validates the graph', () => {
    const json = JSON.stringify({
      meta: { id: 'w1', name: 'Flaky Test Triage', description: 'd', version: 1, created: '2026-06-17T00:00:00Z', updated: '2026-06-17T00:00:00Z' },
      nodes: [{ id: 'n1', position: { x: 100, y: 300 }, exportedSlug: null, agent: { name: 'Tester', description: 'd', completionCriteria: 'c' } }],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'done', terminalType: 'complete' }],
    })
    const cwc = parseWorkflowJson('here you go:\n' + json)
    expect(cwc.meta.name).toBe('Flaky Test Triage')
    expect(cwc.nodes).toHaveLength(1)
  })

  it('throws on a graph whose edge points at a missing node', () => {
    const bad = JSON.stringify({
      meta: { id: 'w1', name: 'X', description: '', version: 1, created: '', updated: '' },
      nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'A', description: '', completionCriteria: '' } }],
      edges: [{ id: 'e1', from: 'n1', to: 'ghost', trigger: 't' }],
    })
    expect(() => parseWorkflowJson(bad)).toThrow()
  })
})
