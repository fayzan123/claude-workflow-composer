// src/server/run-store.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RunEvent, RunStatus } from '../run-events.js'
import {
  createRunManifestStore,
  runActionAvailability,
  type ManagedRunState,
  type RunActionAvailability,
  type RunActionError,
  type RunManifest,
  type RunManifestStore,
  type RunResultDisposition,
} from './run-manifest.js'

const STALE_AFTER_MS = 15 * 60_000

function parseTimestamp(ts: string): number | null {
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : null
}

export interface RunSummary {
  runId: string
  workflowId: string
  workflowSlug: string
  source: 'test' | 'external'
  status: RunStatus | 'running' | 'stale' | 'paused'
  startedAt: string
  lastEventAt: string
  durationMs: number
  cwd?: string
  branch?: string
  trigger?: string
  managed: boolean
  lifecycleState?: ManagedRunState
  isolation?: 'worktree' | 'in-place'
  disposition: RunResultDisposition
  resultSha?: string
  appliedSha?: string
  actions: RunActionAvailability
  actionError: RunActionError | null
}

export interface RunStore {
  readonly manifests: RunManifestStore
  append(event: RunEvent): Promise<void>
  appendExternal(event: RunEvent): Promise<boolean>
  getEvents(workflowId: string, runId: string): Promise<RunEvent[] | null>
  listRuns(workflowId: string, manifestStore?: RunManifestStore): Promise<RunSummary[]>
  onEvent(listener: (e: RunEvent) => void): () => void
  registerRun(runId: string, workflowId: string, stop: () => void, launchGroupId?: string): boolean
  reserveWorkflow(workflowId: string, reservationId: string): boolean
  releaseWorkflowReservation(workflowId: string, reservationId: string): void
  stopRun(runId: string): boolean
  releaseRun(runId: string): void
  hasActiveTestRun(workflowId: string): boolean
  isActive(runId: string): boolean
}

const NO_ACTIONS: RunActionAvailability = { diff: false, approve: false, reject: false, apply: false, discard: false }

export function createRunStore(runsDir: string, defaultManifestStore: RunManifestStore = createRunManifestStore(runsDir)): RunStore {
  const listeners = new Set<(e: RunEvent) => void>()
  const activeRuns = new Map<string, { workflowId: string; launchGroupId: string; stop: () => void; stopRequested: boolean }>()
  const workflowReservations = new Map<string, string>()
  const appendQueues = new Map<string, Promise<void>>()

  function runFile(workflowId: string, runId: string): string {
    return path.join(runsDir, workflowId, `${runId}.jsonl`)
  }

  async function readEvents(workflowId: string, runId: string): Promise<RunEvent[] | null> {
    try {
      const raw = await fs.readFile(runFile(workflowId, runId), 'utf-8')
      return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunEvent)
    } catch {
      return null
    }
  }

  function appendKey(workflowId: string, runId: string): string {
    return JSON.stringify([workflowId, runId])
  }

  function serializeAppend<T>(workflowId: string, runId: string, job: () => Promise<T>): Promise<T> {
    const key = appendKey(workflowId, runId)
    const previous = appendQueues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(job)
    const tail = result.then(() => undefined, () => undefined)
    appendQueues.set(key, tail)
    void tail.then(() => {
      if (appendQueues.get(key) === tail) appendQueues.delete(key)
    })
    return result
  }

  async function writeEvent(event: RunEvent): Promise<void> {
    const dir = path.join(runsDir, event.workflowId)
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(runFile(event.workflowId, event.runId), JSON.stringify(event) + '\n')
    for (const listener of listeners) listener(event)
  }

  function managedRunSettled(events: RunEvent[] | null): boolean {
    if (!events || events[0]?.source !== 'test') return false
    const managedEvent = [...events].reverse().find(event => event.source === 'test')
    return managedEvent?.type === 'run_completed' || managedEvent?.type === 'run_paused'
  }

  function summarize(events: RunEvent[]): RunSummary {
    const first = events[0]
    const last = events[events.length - 1]
    const lastManagedEvent = first.source === 'test'
      ? [...events].reverse().find(event => event.source === 'test')
      : undefined
    const stateEvent = lastManagedEvent?.type === 'run_completed' || lastManagedEvent?.type === 'run_paused'
      ? lastManagedEvent
      : last
    const firstTs = parseTimestamp(first.ts)
    const lastTs = parseTimestamp(stateEvent.ts)
    let status: RunSummary['status']
    if (stateEvent.type === 'run_completed' && stateEvent.status) {
      status = stateEvent.status
    } else if (stateEvent.type === 'run_paused' || stateEvent.type === 'awaiting_approval') {
      status = 'paused'                       // gates can wait days — stale window does not apply
    } else if (lastTs === null || Date.now() - lastTs > STALE_AFTER_MS) {
      status = 'stale'
    } else {
      status = 'running'
    }
    return {
      runId: first.runId,
      workflowId: first.workflowId,
      workflowSlug: first.workflowSlug,
      source: first.source ?? 'external',
      status,
      startedAt: first.ts,
      lastEventAt: stateEvent.ts,
      durationMs: firstTs === null || lastTs === null ? 0 : Math.max(0, lastTs - firstTs),
      cwd: first.cwd,
      branch: first.branch,
      trigger: first.trigger,
      managed: false,
      disposition: 'unavailable',
      actions: { ...NO_ACTIONS },
      actionError: null,
    }
  }

  function applyManifest(summary: RunSummary, manifest: RunManifest): void {
    summary.managed = true
    summary.lifecycleState = manifest.lifecycleState
    summary.isolation = manifest.requestedIsolation
    summary.disposition = manifest.disposition
    summary.actions = runActionAvailability(manifest)
    summary.actionError = manifest.actionError
    summary.cwd = manifest.originalCwd
    summary.branch = manifest.branch
    summary.trigger = manifest.triggerId
    if (manifest.resultSha) summary.resultSha = manifest.resultSha
    if (manifest.appliedSha) summary.appliedSha = manifest.appliedSha
    if (manifest.lifecycleState === 'paused') summary.status = 'paused'
    if (['completed', 'failed', 'aborted', 'rejected'].includes(manifest.lifecycleState) && manifest.completionStatus) {
      summary.status = manifest.completionStatus
    }
  }

  return {
    manifests: defaultManifestStore,
    append(event: RunEvent): Promise<void> {
      return serializeAppend(event.workflowId, event.runId, () => writeEvent(event))
    },

    appendExternal(event: RunEvent): Promise<boolean> {
      return serializeAppend(event.workflowId, event.runId, async () => {
        if (managedRunSettled(await readEvents(event.workflowId, event.runId))) return false
        await writeEvent(event)
        return true
      })
    },

    getEvents: readEvents,

    async listRuns(workflowId: string, manifestStore = defaultManifestStore): Promise<RunSummary[]> {
      let files: string[]
      try {
        files = (await fs.readdir(path.join(runsDir, workflowId))).filter(f => f.endsWith('.jsonl'))
      } catch {
        return []
      }
      const summaries: RunSummary[] = []
      for (const f of files) {
        const runId = f.replace(/\.jsonl$/, '')
        const events = await readEvents(workflowId, runId)
        if (events && events.length > 0) {
          const summary = summarize(events)
          try {
            const manifest = await manifestStore.read(workflowId, runId)
            if (manifest) applyManifest(summary, manifest)
          } catch {
            // Corrupt server-owned data grants no authority; keep the JSONL run visible.
          }
          // A run still in the active registry is mid-flight in this process. Its child
          // can write `awaiting_approval` to disk (status → paused) a beat before the
          // parent runs classifyAndFinish → releaseRun. Report it as 'running' until it's
          // released, so the public status stays consistent with hasActiveTestRun and a
          // client can't try to approve/reject a run that hasn't been released yet.
          // (Fixes a flaky approve/reject race on slow CI legs.)
          if (summary.status === 'paused' && activeRuns.has(runId)) {
            summary.status = 'running'
          }
          summaries.push(summary)
        }
      }
      return summaries.sort((a, b) => (parseTimestamp(b.startedAt) ?? 0) - (parseTimestamp(a.startedAt) ?? 0))
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    registerRun(runId, workflowId, stop, launchGroupId) {
      const existing = activeRuns.get(runId)
      if (existing) {
        if (existing.workflowId !== workflowId) return false
        activeRuns.set(runId, { ...existing, stop })
        if (existing.stopRequested) stop()
        return true
      }

      if (workflowReservations.has(workflowId)) return false
      const claim = launchGroupId ?? runId
      for (const active of activeRuns.values()) {
        if (active.workflowId === workflowId && active.launchGroupId !== claim) return false
      }
      activeRuns.set(runId, { workflowId, launchGroupId: claim, stop, stopRequested: false })
      return true
    },
    reserveWorkflow(workflowId, reservationId) {
      if (workflowReservations.has(workflowId)) return false
      for (const active of activeRuns.values()) {
        if (active.workflowId === workflowId) return false
      }
      workflowReservations.set(workflowId, reservationId)
      return true
    },
    releaseWorkflowReservation(workflowId, reservationId) {
      if (workflowReservations.get(workflowId) === reservationId) {
        workflowReservations.delete(workflowId)
      }
    },
    stopRun(runId) {
      const entry = activeRuns.get(runId)
      if (!entry) return false
      entry.stopRequested = true
      entry.stop()
      return true
    },
    releaseRun(runId) { activeRuns.delete(runId) },
    hasActiveTestRun(workflowId) {
      for (const v of activeRuns.values()) if (v.workflowId === workflowId) return true
      return false
    },
    isActive(runId) { return activeRuns.has(runId) },
  }
}
