// src/server/scan-store.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DetectedAutomation } from '../detection/types.js'
import type { StreamLogEvent } from './streaming-analyzer.js'

export interface LogEntry extends StreamLogEvent { ts: string }
interface GenerationState {
  id: string
  step: string
  startedAt: string
  workflowId?: string
  error?: string
}

interface ScanResult {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  error?: string
  automations: DetectedAutomation[]
  log: LogEntry[]
  generation?: GenerationState | null
}

export interface ScanStore {
  getLatest(): ScanResult | null
  getGeneration(): GenerationState | null
  setGeneration(state: GenerationState | null): Promise<void>
  /** Register the detached background promotion job so shutdown/tests can await it. */
  trackPromotion(job: Promise<void>): void
  /** Resolves once the tracked promotion job AND all queued persists have flushed. */
  whenPromotionSettled(): Promise<void>
  isRunning(): boolean
  hasActivePromotion(): boolean
  onLog(cb: (e: LogEntry) => void): () => void
  appendLog(e: StreamLogEvent): void
  runScan(job: () => Promise<DetectedAutomation[]>): Promise<void>
  setStatus(id: string, status: DetectedAutomation['status'], statusDetail?: string): Promise<DetectedAutomation | null>
}

export function createScanStore(filePath: string): ScanStore {
  let latest: ScanResult | null = null
  try { latest = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* none yet */ }
  if (latest) {
    for (const a of latest.automations) {
      if (a.status === 'promoting') {
        a.status = 'promotion_failed'
        a.statusDetail = 'Workflow generation was interrupted before it finished.'
      }
    }
    if (latest.generation && !latest.generation.workflowId && !latest.generation.error) {
      const interruptedId = latest.generation.id
      latest.generation = null
      const a = latest.automations.find(candidate => candidate.id === interruptedId)
      if (a) {
        a.status = 'promotion_failed'
        a.statusDetail = 'Workflow generation was interrupted before it finished.'
      }
    }
  }
  let running = false
  let persistQueue: Promise<void> = Promise.resolve()
  let promotionJob: Promise<void> = Promise.resolve()
  let persistCounter = 0
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)   // SSE fan-out: many concurrent /stream clients, cleaned up on disconnect

  function persist(): Promise<void> {
    const snapshot = JSON.stringify(latest, null, 2)
    const tmp = `${filePath}.${process.pid}.${++persistCounter}.tmp`
    const write = persistQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot)
      await fs.rename(tmp, filePath)
    })
    persistQueue = write.catch(() => undefined)
    return write
  }

  /** Carry terminal user decisions forward onto freshly-detected automations by id. */
  function reconcile(fresh: DetectedAutomation[], prior: DetectedAutomation[]): DetectedAutomation[] {
    const priorMap = new Map(prior.map(a => [a.id, a.status]))
    return fresh.map(a => {
      const was = priorMap.get(a.id)
      return was === 'dismissed' || was === 'promoted' ? { ...a, status: was } : a
    })
  }

  return {
    getLatest: () => latest,
    getGeneration: () => latest?.generation ?? null,
    async setGeneration(state) {
      if (!latest) {
        latest = {
          status: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          automations: [],
          log: [],
        }
      }
      latest.generation = state
      await persist()
    },
    trackPromotion(job) { promotionJob = job.catch(() => undefined) },
    async whenPromotionSettled() { await promotionJob; await persistQueue },
    isRunning: () => running,
    hasActivePromotion: () => {
      const persistedGeneration = latest?.generation
      if (persistedGeneration && !persistedGeneration.workflowId && !persistedGeneration.error) return true
      return latest?.automations.some(a => a.status === 'promoting') ?? false
    },
    onLog(cb) { emitter.on('log', cb); return () => emitter.off('log', cb) },
    appendLog(e) {
      const entry: LogEntry = { ts: new Date().toISOString(), ...e }
      if (latest) { latest.log.push(entry); if (latest.log.length > 2000) latest.log.shift() }
      emitter.emit('log', entry)
    },
    async runScan(job) {
      if (running) throw new Error('A scan is already running.')
      running = true
      const priorAutomations = latest?.automations ?? []
      latest = { status: 'running', startedAt: new Date().toISOString(), automations: [], log: [] }
      await persist()
      try {
        const automations = reconcile(await job(), priorAutomations)
        latest = { status: 'done', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), automations, log: latest.log, generation: latest.generation ?? null }
      } catch (err) {
        latest = { status: 'error', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : 'scan failed', automations: [], log: latest?.log ?? [], generation: latest?.generation ?? null }
      } finally {
        running = false
        await persist()
      }
    },
    async setStatus(id, status, statusDetail) {
      const a = latest?.automations.find(x => x.id === id)
      if (!a) return null
      a.status = status
      if (statusDetail) a.statusDetail = statusDetail
      else delete a.statusDetail
      await persist()
      return a
    },
  }
}
