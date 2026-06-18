// src/server/scan-store.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { DetectedAutomation } from '../detection/types.js'

export interface ScanProgress { stage: string; detail?: string }
export interface ScanResult {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  error?: string
  automations: DetectedAutomation[]
}

export interface ScanStore {
  getLatest(): ScanResult | null
  isRunning(): boolean
  onProgress(cb: (p: ScanProgress) => void): () => void
  emitProgress(p: ScanProgress): void
  runScan(job: () => Promise<DetectedAutomation[]>): Promise<void>
  setStatus(id: string, status: DetectedAutomation['status']): Promise<DetectedAutomation | null>
}

export function createScanStore(filePath: string): ScanStore {
  let latest: ScanResult | null = null
  try { latest = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* none yet */ }
  let running = false
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)   // SSE fan-out: many concurrent /stream clients, cleaned up on disconnect

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(latest, null, 2))
    await fs.rename(tmp, filePath)
  }

  /** Carry dismissed/promoted status forward onto freshly-detected automations by id. */
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
    onProgress(cb) { emitter.on('p', cb); return () => emitter.off('p', cb) },
    emitProgress(p) { emitter.emit('p', p) },
    async runScan(job) {
      if (running) throw new Error('A scan is already running.')
      running = true
      const priorAutomations = latest?.automations ?? []
      latest = { status: 'running', startedAt: new Date().toISOString(), automations: [] }
      await persist()
      try {
        const automations = reconcile(await job(), priorAutomations)
        latest = { status: 'done', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), automations }
      } catch (err) {
        latest = { status: 'error', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : 'scan failed', automations: [] }
      } finally {
        running = false
        await persist()
      }
    },
    async setStatus(id, status) {
      const a = latest?.automations.find(x => x.id === id)
      if (!a) return null
      a.status = status
      await persist()
      return a
    },
  }
}
