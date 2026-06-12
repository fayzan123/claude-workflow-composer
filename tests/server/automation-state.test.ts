// tests/server/automation-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createAutomationState, armHash } from '../../src/server/automation-state.js'
import type { CwcTrigger } from '../../src/schema.js'

let file: string
const trig: CwcTrigger = {
  id: 'trig-1', type: 'cron', schedule: '0 9 * * *', cwd: '/tmp/p',
  isolation: 'in-place', catchUp: true, maxRunsPerDay: 2, enabled: true,
}

// NOTE: createAutomationState is SYNCHRONOUS (initial load via readFileSync) so createApp
// can stay sync; mutating methods (arm/recordFire/...) are async.
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-astate-'))
  file = path.join(dir, 'automation-state.json')
})
afterEach(async () => { await fs.rm(path.dirname(file), { recursive: true }) })

describe('arming', () => {
  it('triggers are unarmed by default; arming is sticky across reload', async () => {
    const s = createAutomationState(file)
    expect(s.isArmed(trig)).toBe(false)
    await s.arm(trig)
    expect(s.isArmed(trig)).toBe(true)
    const reloaded = createAutomationState(file)
    expect(reloaded.isArmed(trig)).toBe(true)
  })
  it('editing a dangerous field invalidates the arm', async () => {
    const s = createAutomationState(file)
    await s.arm(trig)
    expect(s.isArmed({ ...trig, precondition: 'rm -rf /' })).toBe(false)
    expect(s.isArmed({ ...trig, cwd: '/elsewhere' })).toBe(false)
    expect(s.isArmed({ ...trig, schedule: '* * * * *' })).toBe(false)
    expect(s.isArmed({ ...trig, maxRunsPerDay: 99 })).toBe(true)   // cap is not a dangerous field
  })
})

describe('caps + fire/skip recording', () => {
  it('enforces maxRunsPerDay and resets on date change', async () => {
    const s = createAutomationState(file)
    const day1 = new Date('2026-06-12T09:00:00')
    expect(s.canFire(trig, day1)).toBe(true)
    await s.recordFire(trig.id, day1)
    await s.recordFire(trig.id, day1)
    expect(s.canFire(trig, day1)).toBe(false)
    expect(s.canFire(trig, new Date('2026-06-13T09:00:00'))).toBe(true)
  })
  it('records skips with reason and persists lastFiredAt', async () => {
    const s = createAutomationState(file)
    const now = new Date('2026-06-12T09:00:00')
    await s.recordFire(trig.id, now)
    await s.recordSkip(trig.id, 'precondition', now)
    const t = s.getTriggerState(trig.id)
    expect(t.lastFiredAt).toBe(now.toISOString())
    expect(t.skippedCount).toBe(1)
    expect(t.lastSkip).toMatchObject({ reason: 'precondition' })
  })
})

describe('global pause', () => {
  it('round-trips', async () => {
    const s = createAutomationState(file)
    expect(s.isPaused()).toBe(false)
    await s.setPaused(true)
    expect(createAutomationState(file).isPaused()).toBe(true)
  })
})
