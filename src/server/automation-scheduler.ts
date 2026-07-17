// src/server/automation-scheduler.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Cron } from 'croner'
import type { CwcFile, CwcTrigger } from '../schema.js'
import { deployedArtifactSkillSlug } from '../slugify.js'
import type { AutomationState } from './automation-state.js'

export interface SchedulerDeps {
  workflowsDir: string
  state: AutomationState
  /** fire is the launcher binding; resolves when the RUN SETTLES (its promise gates a concurrency slot). */
  fire: (workflowId: string, workflowSlug: string, trigger: CwcTrigger) => Promise<unknown>
  /** 'running' | 'paused-same-trigger' | false */
  isWorkflowBusy: (workflowId: string, triggerId: string) => Promise<'running' | 'paused-same-trigger' | false>
  now?: () => Date
  intervalMs?: number
  maxConcurrent?: number
}

interface Entry { workflowId: string; workflowSlug: string; trigger: CwcTrigger }
interface DueEntry extends Entry { occurrence: Date }

export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? (() => new Date())
  const maxConcurrent = deps.maxConcurrent ?? 2
  let entries: Entry[] = []
  let active = 0
  const queue: DueEntry[] = []
  let timer: NodeJS.Timeout | null = null
  let operationQueue: Promise<void> = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function entryKey(entry: Entry): string {
    return JSON.stringify([entry.workflowId, entry.trigger.id])
  }

  function entrySnapshot(entry: Entry): string {
    return JSON.stringify([entry.workflowSlug, entry.trigger])
  }

  function dueKey(entry: DueEntry): string {
    return JSON.stringify([entry.workflowId, entry.trigger.id, entry.occurrence.toISOString()])
  }

  async function rescanNow(): Promise<void> {
    const next: Entry[] = []
    let files: string[] = []
    try { files = (await fs.readdir(deps.workflowsDir)).filter(f => f.endsWith('.cwc')) } catch { /* none */ }
    for (const f of files) {
      try {
        const cwc = JSON.parse(await fs.readFile(path.join(deps.workflowsDir, f), 'utf-8')) as CwcFile
        for (const t of cwc.meta.triggers ?? []) {
          if (t.type === 'cron' && t.schedule) next.push({ workflowId: cwc.meta.id, workflowSlug: deployedArtifactSkillSlug(cwc), trigger: t })
        }
      } catch { /* unreadable file — skip */ }
    }
    entries = next

    // Queued occurrences are reservations against a specific persisted trigger.
    // Keep only byte-for-byte-equivalent recipes; any edit, disable, or deletion
    // invalidates the old authority and the next tick can derive fresh work.
    const current = new Map(next.map(entry => [entryKey(entry), entry]))
    for (let index = queue.length - 1; index >= 0; index--) {
      const replacement = current.get(entryKey(queue[index]))
      if (!replacement || entrySnapshot(replacement) !== entrySnapshot(queue[index])) {
        queue.splice(index, 1)
      } else {
        queue[index] = { ...replacement, occurrence: queue[index].occurrence }
      }
    }
  }

  function dueOccurrence(t: CwcTrigger, lastFiredAt: string | undefined, at: Date): Date | null {
    if (!lastFiredAt) return null   // armed-at initializes lastFiredAt; absence means unarmed/new
    try {
      const nextRun = new Cron(t.schedule!).nextRun(new Date(lastFiredAt))
      return nextRun !== null && nextRun.getTime() <= at.getTime() ? nextRun : null
    } catch { return null }   // invalid expression — client validates; never crash the loop
  }

  function launch(e: Entry): void {
    active++
    void deps.fire(e.workflowId, e.workflowSlug, e.trigger)
      .catch(() => { /* fire path logs its own failures */ })
      .finally(() => {
        active--
        void serialize(drainQueueNow)
      })
  }

  async function maybeFire(e: DueEntry): Promise<void> {
    const current = entries.find(entry => entryKey(entry) === entryKey(e))
    const at = now()
    if (!current || entrySnapshot(current) !== entrySnapshot(e)) {
      await deps.state.recordSkip(e.trigger.id, 'trigger changed before launch', at, e.occurrence).catch(() => {})
      return
    }
    const candidate = { ...current, occurrence: e.occurrence }
    const t = candidate.trigger
    if (!t.enabled) {
      await deps.state.recordSkip(t.id, 'trigger disabled', at, e.occurrence).catch(() => {})
      return
    }
    if (!deps.state.isArmed(t)) {
      await deps.state.recordSkip(t.id, 'trigger not armed', at, e.occurrence).catch(() => {})
      return
    }
    if (deps.state.isPaused()) {
      await deps.state.recordSkip(t.id, 'automations paused', at, e.occurrence).catch(() => {})
      return
    }
    const busy = await deps.isWorkflowBusy(candidate.workflowId, t.id)
    if (busy) {
      await deps.state.recordSkip(t.id, busy === 'running' ? 'running' : 'paused run awaiting review', at, e.occurrence).catch(() => {})
      return
    }
    if (active >= maxConcurrent) {
      if (!queue.some(queued => dueKey(queued) === dueKey(candidate))) queue.push(candidate)
      return
    }
    launch(candidate)
  }

  async function drainQueueNow(): Promise<void> {
    while (queue.length > 0 && active < maxConcurrent) {
      await maybeFire(queue.shift()!)
    }
  }

  async function tickNow(): Promise<void> {
    const at = now()
    for (const e of entries) {
      const t = e.trigger
      if (!t.enabled) continue
      if (!deps.state.isArmed(t)) continue
      const st = deps.state.getTriggerState(t.id)
      const occurrence = dueOccurrence(t, st.lastFiredAt, at)
      if (!occurrence) continue
      if (deps.state.isPaused()) { await deps.state.recordSkip(t.id, 'automations paused', at, occurrence); continue }
      if (!deps.state.canFire(t, at)) { await deps.state.recordSkip(t.id, 'daily cap', at, occurrence); continue }
      if (!t.catchUp) {
        // if the due time is older than ~2 ticks, this is a missed firing — consume without firing
        if (at.getTime() - occurrence.getTime() > 2 * (deps.intervalMs ?? 30_000)) {
          await deps.state.recordFire(t.id, at)   // consume; recordFire also sets lastFiredAt
          await deps.state.recordSkip(t.id, 'missed (catch-up off)', at, occurrence)
          continue
        }
      }
      await deps.state.recordFire(t.id, at)   // BEFORE firing — no double-fire on slow spawns
      await maybeFire({ ...e, occurrence })
    }
    await drainQueueNow()
  }

  const rescan = (): Promise<void> => serialize(rescanNow)
  const tick = (): Promise<void> => serialize(tickNow)

  return {
    rescan,
    tick,
    start(): void {
      void rescan().then(() => tick())
      timer = setInterval(() => { void tick() }, deps.intervalMs ?? 30_000)
      timer.unref()
    },
    stop(): void { if (timer) clearInterval(timer) },
  }
}
