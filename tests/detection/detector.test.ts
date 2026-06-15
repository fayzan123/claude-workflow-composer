import { describe, it, expect } from 'vitest'
import { detectCandidates } from '../../src/detection/detector.js'
import type { TaskUnit } from '../../src/detection/types.js'

function u(commands: string[], startedAt: string, cwd = '/r'): TaskUnit {
  return { sessionId: 'S', cwd, startedAt, endedAt: startedAt, tools: ['Edit'], commands }
}

describe('detectCandidates', () => {
  it('surfaces a compound signature seen >= threshold times, ignoring noise, below-threshold, and single-step', () => {
    const units = [
      u(['npm test', 'git push'], '2026-06-01T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-02T10:00:00Z'),
      u(['npm test', 'git push'], '2026-06-03T10:00:00Z'),
      u(['ls'], '2026-06-03T11:00:00Z'),                 // noise (no salient) → ignored
      u(['npm publish'], '2026-06-04T10:00:00Z'),        // below threshold (1) → ignored
      u(['npm run build'], '2026-06-05T10:00:00Z'),      // single-step (1 label) → ignored even if frequent
      u(['npm run build'], '2026-06-06T10:00:00Z'),
      u(['npm run build'], '2026-06-07T10:00:00Z'),
    ]
    const cands = detectCandidates(units, { minCount: 3 })
    expect(cands).toHaveLength(1)
    expect(cands[0].signature).toBe('tests+git-push')
    expect(cands[0].count).toBe(3)
    expect(cands[0].trigger.kind).toBe('schedule')   // all 3 cluster at ~10:00 UTC
    expect(cands[0].cwds).toEqual(['/r'])
    expect(cands[0].summary).toBe('tests → git-push')
  })
  it('sorts compound candidates by count desc', () => {
    const mk = (cmds: string[], n: number, base: string) => Array.from({ length: n }, (_, i) => u(cmds, `${base}${i}Z`))
    const units = [
      ...mk(['npm test', 'npm run build'], 4, '2026-06-01T0'),    // tests+build ×4
      ...mk(['npm run build', 'npm publish'], 3, '2026-06-02T0'), // build+publish ×3
    ]
    const cands = detectCandidates(units, { minCount: 3 })
    expect(cands.map(c => c.count)).toEqual([4, 3])
  })
})
