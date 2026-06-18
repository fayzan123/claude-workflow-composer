import { describe, it, expect } from 'vitest'
import { buildDigests } from '../../src/detection/digest-builder.js'
import type { TaskUnit } from '../../src/detection/types.js'

function unit(p: Partial<TaskUnit>): TaskUnit {
  return { sessionId: 's', cwd: '/repo', promptText: 'do a thing', startedAt: '2026-06-14T09:00:00.000Z', endedAt: '2026-06-14T09:05:00.000Z', tools: ['Bash'], commands: ['npm test'], ...p }
}

describe('buildDigests', () => {
  it('caps per-repo lines at maxPerRepo (most-recent kept) and assigns sequential refs starting at r0', () => {
    // 12 units in one repo with distinct timestamps; maxPerRepo=5 should keep only the 5 newest
    const units = Array.from({ length: 12 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      return unit({ cwd: '/repo', startedAt: `2026-06-${day}T10:00:00.000Z` })
    })
    const digests = buildDigests(units, { maxPerRepo: 5 })
    expect(digests).toHaveLength(1)
    expect(digests[0].lines).toHaveLength(5)
    // All emitted refs must be sequential from r0
    const refs = digests[0].lines.map(l => l.ref)
    expect(refs).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    // The kept lines should be the 5 most-recent (days 08–12)
    const timestamps = digests[0].lines.map(l => l.unit.startedAt)
    expect(timestamps).toEqual([
      '2026-06-12T10:00:00.000Z',
      '2026-06-11T10:00:00.000Z',
      '2026-06-10T10:00:00.000Z',
      '2026-06-09T10:00:00.000Z',
      '2026-06-08T10:00:00.000Z',
    ])
  })

  it('drops trivial units (no tools), buckets by repo, assigns sequential refs', () => {
    const digests = buildDigests([
      unit({ cwd: '/a', tools: ['Bash'], commands: ['npm test'] }),
      unit({ cwd: '/a', tools: [], commands: [] }),            // trivial → dropped
      unit({ cwd: '/b', tools: ['Edit'], commands: [] }),
    ])
    const repos = digests.map(d => d.repo).sort()
    expect(repos).toEqual(['/a', '/b'])
    const allRefs = digests.flatMap(d => d.lines.map(l => l.ref))
    expect(allRefs).toEqual(['r0', 'r1'])     // only the 2 non-trivial units
  })

  it('formats a digest line with date, prompt, tools and salient labels', () => {
    const [d] = buildDigests([unit({ promptText: 'fix flaky test', tools: ['Edit', 'Bash'], commands: ['npm test', 'git push'] })])
    expect(d.lines[0].text).toContain('[r0]')
    expect(d.lines[0].text).toContain('fix flaky test')
    expect(d.lines[0].text).toContain('tests')
    expect(d.lines[0].text).toContain('git-push')
  })
})
