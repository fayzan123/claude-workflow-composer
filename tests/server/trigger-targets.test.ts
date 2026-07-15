import { describe, it, expect } from 'vitest'
import { launchTriggerTargets, resolveTargets } from '../../src/server/trigger-targets.js'
import type { CwcTrigger } from '../../src/schema.js'

const base: CwcTrigger = { id: 't', type: 'cron', schedule: '* * * * *', cwd: '/a', isolation: 'worktree', catchUp: false, maxRunsPerDay: 1, enabled: true }

describe('resolveTargets', () => {
  it('returns just cwd when no targets', () => {
    expect(resolveTargets(base)).toEqual(['/a'])
  })
  it('includes cwd plus targets, de-duplicated, order-stable', () => {
    expect(resolveTargets({ ...base, targets: ['/b', '/a', '/c'] })).toEqual(['/a', '/b', '/c'])
  })
  it('ignores blank entries', () => {
    expect(resolveTargets({ ...base, targets: ['', '  ', '/b'] })).toEqual(['/a', '/b'])
  })
  it('launches each normalized target once and retains target/result pairing', async () => {
    const launched = await launchTriggerTargets({ ...base, targets: ['/b', '/a'] }, async cwd => `run:${cwd}`)
    expect(launched).toEqual([
      { cwd: '/a', outcome: 'run:/a' },
      { cwd: '/b', outcome: 'run:/b' },
    ])
  })
})
