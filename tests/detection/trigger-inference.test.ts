import { describe, it, expect } from 'vitest'
import { inferTrigger } from '../../src/detection/trigger-inference.js'
import type { TaskUnit } from '../../src/detection/types.js'

function u(commands: string[], startedAt: string): TaskUnit {
  return { sessionId: 'S', cwd: '/r', startedAt, endedAt: startedAt, tools: [], commands }
}

describe('inferTrigger', () => {
  it('schedule when occurrences cluster at a regular hour', () => {
    const t = inferTrigger([
      u(['npm run build'], '2026-06-01T09:00:00Z'),
      u(['npm run build'], '2026-06-02T09:05:00Z'),
      u(['npm run build'], '2026-06-03T08:58:00Z'),
    ])
    expect(t.kind).toBe('schedule')
    expect(t.label).toMatch(/09|9/)
  })
  it('manual when occurrences are spread across the day', () => {
    const t = inferTrigger([
      u(['npm run build'], '2026-06-01T09:00:00Z'),
      u(['npm run build'], '2026-06-02T19:00:00Z'),
      u(['npm run build'], '2026-06-03T02:00:00Z'),
    ])
    expect(t.kind).toBe('manual')
  })
  it('does NOT infer an event trigger from task contents (deferred to the live hook)', () => {
    const t = inferTrigger([
      u(['npm test', 'git push'], '2026-06-01T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-03T15:00:00Z'),
      u(['npm test', 'git push'], '2026-06-05T20:00:00Z'),
    ])
    expect(t.kind).not.toBe('event')   // spread hours + no antecedent signal → manual
    expect(t.kind).toBe('manual')
  })
})
