import { describe, it, expect } from 'vitest'
import { analyzeUnits, buildAnalysisContext, parseAutomations } from '../../src/detection/analyzer.js'
import type { TaskUnit } from '../../src/detection/types.js'

function unit(p: Partial<TaskUnit>): TaskUnit {
  return { sessionId: 's1', cwd: '/repo', promptText: 'x', startedAt: '2026-06-14T09:00:00.000Z', endedAt: '2026-06-14T09:05:00.000Z', tools: ['Bash'], commands: ['npm test'], ...p }
}

describe('analyzeUnits', () => {
  it('computes server-side evidence and a stable id from cited refs', async () => {
    const units = [
      unit({ sessionId: 'A', cwd: '/repo', startedAt: '2026-06-10T09:00:00.000Z' }),
      unit({ sessionId: 'B', cwd: '/repo', startedAt: '2026-06-12T09:00:00.000Z' }),
      unit({ sessionId: 'C', cwd: '/other', startedAt: '2026-06-14T09:00:00.000Z' }),
    ]
    const runner = async () => ({ result: JSON.stringify({ automations: [{
      title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
      stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
      suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily 9am' }, confidence: 0.9,
    }] }), sessionId: 's' })

    const [a] = await analyzeUnits(units, runner)
    expect(a.evidence.count).toBe(3)
    expect(a.evidence.repos.sort()).toEqual(['/other', '/repo'])
    expect(a.evidence.firstSeen).toBe('2026-06-10T09:00:00.000Z')
    expect(a.evidence.lastSeen).toBe('2026-06-14T09:00:00.000Z')
    expect(a.suggestedTrigger.cron).toBe('0 9 * * *')
    expect(a.status).toBe('new')
    expect(a.id).toMatch(/^[0-9a-f]{12}$/)

    // id is stable across re-analysis (same repos + stepTokens)
    const [a2] = await analyzeUnits(units, runner)
    expect(a2.id).toBe(a.id)
  })

  it('returns [] when the model returns no JSON object', async () => {
    const runner = async () => ({ result: 'no json here', sessionId: 's' })
    expect(await analyzeUnits([unit({})], runner)).toEqual([])
  })
})

describe('buildAnalysisContext + parseAutomations', () => {
  it('builds a refIndex and parses a result string into automations', () => {
    const units = [
      { sessionId: 'A', cwd: '/repo', promptText: 'x', startedAt: '2026-06-10T09:00:00.000Z', endedAt: '', tools: ['Bash'], commands: ['npm test'] },
      { sessionId: 'B', cwd: '/repo', promptText: 'x', startedAt: '2026-06-12T09:00:00.000Z', endedAt: '', tools: ['Bash'], commands: ['npm test'] },
      { sessionId: 'C', cwd: '/repo', promptText: 'x', startedAt: '2026-06-14T09:00:00.000Z', endedAt: '', tools: ['Bash'], commands: ['npm test'] },
    ]
    const ctx = buildAnalysisContext(units)!
    expect(ctx).not.toBeNull()
    expect(ctx.refIndex.size).toBe(3)
    const out = parseAutomations(JSON.stringify({ automations: [{
      title: 'T', description: 'd', steps: [], stepTokens: ['run-tests'], refs: ['r0', 'r1', 'r2'],
      suggestedTrigger: { kind: 'manual', label: '' }, confidence: 0.8,
    }] }), ctx.refIndex)
    expect(out).toHaveLength(1)
    expect(out[0].evidence.count).toBe(3)
  })

  it('deduplicates cited refs and requires three unique valid occurrences', () => {
    const units = [
      unit({ sessionId: 'A' }),
      unit({ sessionId: 'B' }),
      unit({ sessionId: 'C' }),
    ]
    const ctx = buildAnalysisContext(units)!
    const result = (refs: string[]) => JSON.stringify({ automations: [{
      title: 'T', description: 'd', steps: [], stepTokens: ['run-tests'], refs,
      suggestedTrigger: { kind: 'manual', label: '' }, confidence: 0.8,
    }] })

    const accepted = parseAutomations(result(['r0', 'r0', 'r1', 'r2', 'missing']), ctx.refIndex)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].evidence.count).toBe(3)

    expect(parseAutomations(result(['r0', 'r0', 'r1', 'missing']), ctx.refIndex)).toEqual([])
  })

  it('buildAnalysisContext returns null when there is nothing meaningful', () => {
    expect(buildAnalysisContext([])).toBeNull()
  })
})
