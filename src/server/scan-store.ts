// src/server/scan-store.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DetectedAutomation } from '../detection/types.js'
import type { StreamLogEvent } from './streaming-analyzer.js'

export interface LogEntry extends StreamLogEvent { ts: string }
export interface ScanResult {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  error?: string
  automations: DetectedAutomation[]
  log: LogEntry[]
}

export interface ScanStore {
  getLatest(): ScanResult | null
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
  }
  let running = false
  let persistQueue: Promise<void> = Promise.resolve()
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
    isRunning: () => running,
    hasActivePromotion: () => latest?.automations.some(a => a.status === 'promoting') ?? false,
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
        latest = { status: 'done', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), automations, log: latest.log }
      } catch (err) {
        latest = { status: 'error', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : 'scan failed', automations: [], log: latest?.log ?? [] }
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
