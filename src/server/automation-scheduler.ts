// src/server/automation-scheduler.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Cron } from 'croner'
import type { CwcFile, CwcTrigger } from '../schema.js'
import { slugify } from '../slugify.js'
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

export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? (() => new Date())
  const maxConcurrent = deps.maxConcurrent ?? 2
  let entries: Entry[] = []
  let active = 0
  const queue: Entry[] = []
  let timer: NodeJS.Timeout | null = null

  async function rescan(): Promise<void> {
    const next: Entry[] = []
    let files: string[] = []
    try { files = (await fs.readdir(deps.workflowsDir)).filter(f => f.endsWith('.cwc')) } catch { /* none */ }
    for (const f of files) {
      try {
        const cwc = JSON.parse(await fs.readFile(path.join(deps.workflowsDir, f), 'utf-8')) as CwcFile
        for (const t of cwc.meta.triggers ?? []) {
          if (t.type === 'cron' && t.schedule) next.push({ workflowId: cwc.meta.id, workflowSlug: 'cwc-' + slugify(cwc.meta.name), trigger: t })
        }
      } catch { /* unreadable file — skip */ }
    }
    entries = next
  }

  function isDue(t: CwcTrigger, lastFiredAt: string | undefined, at: Date): boolean {
    if (!lastFiredAt) return false   // armed-at initializes lastFiredAt; absence means unarmed/new
    try {
      const nextRun = new Cron(t.schedule!).nextRun(new Date(lastFiredAt))
      return nextRun !== null && nextRun.getTime() <= at.getTime()
    } catch { return false }   // invalid expression — client validates; never crash the loop
  }

  function launch(e: Entry): void {
    active++
    void deps.fire(e.workflowId, e.workflowSlug, e.trigger)
      .catch(() => { /* fire path logs its own failures */ })
      .finally(() => {
        active--
        const nextUp = queue.shift()
        if (nextUp) void maybeFire(nextUp)   // re-checks skip rules at dequeue
      })
  }

  async function maybeFire(e: Entry): Promise<void> {
    const busy = await deps.isWorkflowBusy(e.workflowId, e.trigger.id)
    if (busy) { await deps.state.recordSkip(e.trigger.id, busy === 'running' ? 'running' : 'paused run awaiting review', now()).catch(() => {}); return }
    if (active >= maxConcurrent) { queue.push(e); return }
    launch(e)
  }

  async function tick(): Promise<void> {
    const at = now()
    for (const e of entries) {
      const t = e.trigger
      if (!t.enabled) continue
      if (!deps.state.isArmed(t)) continue
      const st = deps.state.getTriggerState(t.id)
      if (!isDue(t, st.lastFiredAt, at)) continue
      if (deps.state.isPaused()) { await deps.state.recordSkip(t.id, 'automations paused', at); continue }
      if (!deps.state.canFire(t, at)) { await deps.state.recordSkip(t.id, 'daily cap', at); continue }
      if (!t.catchUp) {
        // if the due time is older than ~2 ticks, this is a missed firing — consume without firing
        const nextRun = new Cron(t.schedule!).nextRun(new Date(st.lastFiredAt!))
        if (nextRun && at.getTime() - nextRun.getTime() > 2 * (deps.intervalMs ?? 30_000)) {
          await deps.state.recordFire(t.id, at)   // consume; recordFire also sets lastFiredAt
          await deps.state.recordSkip(t.id, 'missed (catch-up off)', at)
          continue
        }
      }
      await deps.state.recordFire(t.id, at)   // BEFORE firing — no double-fire on slow spawns
      await maybeFire(e)
    }
    // drain queue opportunistically (slots may have freed between ticks); maybeFire re-checks
    // skip rules and re-queues if slots are still full
    while (queue.length > 0 && active < maxConcurrent) await maybeFire(queue.shift()!)
  }

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
