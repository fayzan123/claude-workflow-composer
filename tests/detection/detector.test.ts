import { describe, it, expect } from 'vitest'
import { detectCandidates } from '../../src/detection/detector.js'
import type { TaskUnit } from '../../src/detection/types.js'

function u(commands: string[], startedAt: string, cwd = '/r'): TaskUnit {
  return { sessionId: 'S', cwd, startedAt, endedAt: startedAt, tools: ['Edit'], commands }
}

describe('detectCandidates', () => {
  it('surfaces a signature seen >= threshold times, ignoring noise and below-threshold', () => {
    const units = [
      u(['npm test', 'git push'], '2026-06-01T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-02T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-03T10:00:00Z'),
      u(['ls'], '2026-06-03T11:00:00Z'),                 // noise (no salient) → ignored
      u(['npm publish'], '2026-06-04T10:00:00Z'),        // below threshold (1) → ignored
    ]
    const cands = detectCandidates(units, { minCount: 3 })
    expect(cands).toHaveLength(1)
    expect(cands[0].signature).toBe('tests+git-push')
    expect(cands[0].count).toBe(3)
    expect(cands[0].trigger.kind).toBe('event')
    expect(cands[0].cwds).toEqual(['/r'])
    expect(cands[0].summary).toBe('tests → git-push')
  })
  it('sorts candidates by count desc', () => {
    const mk = (cmd: string, n: number, ts: string) => Array.from({ length: n }, (_, i) => u([cmd], `${ts}${i}Z`))
    const units = [...mk('npm run build', 4, '2026-06-01T0'), ...mk('npm publish', 3, '2026-06-02T0')]
    const cands = detectCandidates(units, { minCount: 3 })
    expect(cands.map(c => c.count)).toEqual([4, 3])
  })
})
