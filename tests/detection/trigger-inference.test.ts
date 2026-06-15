import { describe, it, expect } from 'vitest'
import { inferTrigger } from '../../src/detection/trigger-inference.js'
import type { TaskUnit } from '../../src/detection/types.js'

function u(commands: string[], startedAt: string): TaskUnit {
  return { sessionId: 'S', cwd: '/r', startedAt, endedAt: startedAt, tools: [], commands }
}

describe('inferTrigger', () => {
  it('event when the task reliably contains a push/commit signal', () => {
    const t = inferTrigger([
      u(['npm test', 'git push'], '2026-06-01T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-03T15:00:00Z'),
      u(['npm test', 'git push'], '2026-06-05T09:00:00Z'),
    ])
    expect(t.kind).toBe('event')
    expect(t.label).toMatch(/push/i)
  })
  it('schedule when occurrences cluster at a regular hour without an event signal', () => {
    const t = inferTrigger([
      u(['npm run build'], '2026-06-01T09:00:00Z'),
      u(['npm run build'], '2026-06-02T09:05:00Z'),
      u(['npm run build'], '2026-06-03T08:58:00Z'),
    ])
    expect(t.kind).toBe('schedule')
    expect(t.label).toMatch(/09|9/)
  })
  it('manual when neither signal is clear', () => {
    const t = inferTrigger([
      u(['npm run build'], '2026-06-01T09:00:00Z'),
      u(['npm run build'], '2026-06-02T19:00:00Z'),
    ])
    expect(t.kind).toBe('manual')
  })
})
