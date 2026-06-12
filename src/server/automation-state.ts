// src/server/automation-state.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { CwcTrigger } from '../schema.js'

export interface TriggerState {
  lastFiredAt?: string
  runsOnDate?: string          // yyyy-mm-dd the runsCount applies to
  runsCount: number
  skippedCount: number
  lastSkip?: { ts: string; reason: string }
  armedHash?: string
}

interface StateFile { paused: boolean; triggers: Record<string, TriggerState> }

/** Hash of the fields whose edit must force re-arming (arbitrary-shell / where / when). */
export function armHash(t: CwcTrigger): string {
  return createHash('sha256')
    .update(JSON.stringify([t.precondition ?? '', t.setupCommand ?? '', t.cwd, t.schedule ?? t.token ?? '']))
    .digest('hex')
}

function dateKey(d: Date): string { return d.toISOString().slice(0, 10) }

export interface AutomationState {
  isPaused(): boolean
  setPaused(p: boolean): Promise<void>
  isArmed(t: CwcTrigger): boolean
  arm(t: CwcTrigger): Promise<void>
  canFire(t: CwcTrigger, now: Date): boolean
  recordFire(triggerId: string, now: Date): Promise<void>
  recordSkip(triggerId: string, reason: string, now: Date): Promise<void>
  getTriggerState(triggerId: string): TriggerState
}

export function createAutomationState(filePath: string): AutomationState {
  let state: StateFile = { paused: false, triggers: {} }
  try { state = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* fresh */ }

  async function save(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2))
    await fs.rename(tmp, filePath)
  }

  function entry(id: string): TriggerState {
    return (state.triggers[id] ??= { runsCount: 0, skippedCount: 0 })
  }

  return {
    isPaused: () => state.paused,
    async setPaused(p) { state.paused = p; await save() },
    isArmed: (t) => entry(t.id).armedHash === armHash(t),
    async arm(t) {
      const e = entry(t.id)
      e.armedHash = armHash(t)
      e.lastFiredAt ??= new Date().toISOString()   // arming never causes an immediate catch-up fire
      await save()
    },
    canFire(t, now) {
      const e = entry(t.id)
      if (e.runsOnDate !== dateKey(now)) return true
      return e.runsCount < t.maxRunsPerDay
    },
    async recordFire(id, now) {
      const e = entry(id)
      if (e.runsOnDate !== dateKey(now)) { e.runsOnDate = dateKey(now); e.runsCount = 0 }
      e.runsCount++
      e.lastFiredAt = now.toISOString()
      await save()
    },
    async recordSkip(id, reason, now) {
      const e = entry(id)
      e.skippedCount++
      e.lastSkip = { ts: now.toISOString(), reason }
      await save()
    },
    getTriggerState: (id) => ({ ...entry(id) }),
  }
}
