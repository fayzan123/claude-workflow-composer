import { describe, it, expect } from 'vitest'
import { buildDigests } from '../../src/detection/digest-builder.js'
import type { TaskUnit } from '../../src/detection/types.js'

function unit(p: Partial<TaskUnit>): TaskUnit {
  return { sessionId: 's', cwd: '/repo', promptText: 'do a thing', startedAt: '2026-06-14T09:00:00.000Z', endedAt: '2026-06-14T09:05:00.000Z', tools: ['Bash'], commands: ['npm test'], ...p }
}

describe('buildDigests', () => {
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
