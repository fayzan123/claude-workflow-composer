// src/server/scan-store.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ArtifactTier, DetectedAutomation } from '../detection/types.js'
import type { ScanDiagnostics } from '../detection/scan-diagnostics.js'
import type { StreamLogEvent } from './streaming-analyzer.js'

export interface LogEntry extends StreamLogEvent { ts: string }
export interface GenerationState {
  id: string
  step: string
  startedAt: string
  tier?: ArtifactTier
  artifactId?: string
  /** Compatibility alias retained for older clients while generation becomes artifact-aware. */
  workflowId?: string
  error?: string
}

interface ScanResult {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  error?: string
  automations: DetectedAutomation[]
  /** Previous completed results retained only while a replacement scan is unresolved. */
  priorAutomations?: DetectedAutomation[]
  log: LogEntry[]
  generation?: GenerationState | null
  diagnostics?: ScanDiagnostics
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
  /** Attach a diagnostics record to the current scan result and persist it. */
  setDiagnostics(d: ScanDiagnostics): Promise<void>
  runScan(job: () => Promise<DetectedAutomation[]>): Promise<void>
  /** Persist classifier/generation metadata that is not a lifecycle status. */
  updateAutomation(id: string, patch: Partial<Omit<DetectedAutomation, 'id'>>): Promise<DetectedAutomation | null>
  /** Commit a generated artifact's automation metadata and completion state in one
   * persisted snapshot. The in-memory view is changed only after that snapshot lands. */
  commitPromotion(
    id: string,
    patch: Partial<Omit<DetectedAutomation, 'id'>>,
    generation: GenerationState,
  ): Promise<DetectedAutomation | null>
  setStatus(id: string, status: DetectedAutomation['status'], statusDetail?: string): Promise<DetectedAutomation | null>
  dismiss(id: string): Promise<DetectedAutomation | null>
  restore(id: string): Promise<DetectedAutomation | null>
}

export function createScanStore(filePath: string): ScanStore {
  function hasAppliedRules(automation: DetectedAutomation): boolean {
    return (automation.ruleApplications?.length ?? 0) > 0
  }

  function cloneAutomation(automation: DetectedAutomation): DetectedAutomation {
    return {
      ...automation,
      ...(automation.ruleApplications
        ? { ruleApplications: automation.ruleApplications.map(application => ({ ...application, target: { ...application.target } })) }
        : {}),
    }
  }

  /** Active rule applications must always stay visible so the user can remove them.
   * Older persisted data may contain a rule that was dismissed before that invariant
   * was enforced; recover it as promoted instead of leaving an unmanaged file edit. */
  function normalizeAppliedRuleVisibility(automation: DetectedAutomation): DetectedAutomation {
    const cloned = cloneAutomation(automation)
    if (!hasAppliedRules(cloned) || cloned.status !== 'dismissed') return cloned
    const { dismissedFromStatus: _dismissedFromStatus, dismissedFromStatusDetail, ...visible } = cloned
    return {
      ...visible,
      status: 'promoted',
      statusDetail: dismissedFromStatusDetail ?? 'Rule remains applied. Remove it before dismissing this automation.',
    }
  }

  function mergeAutomationHistory(
    prior: DetectedAutomation[],
    current: DetectedAutomation[],
  ): DetectedAutomation[] {
    const merged = new Map<string, DetectedAutomation>()
    for (const automation of prior) merged.set(automation.id, normalizeAppliedRuleVisibility(automation))
    for (const automation of current) merged.set(automation.id, normalizeAppliedRuleVisibility(automation))
    return [...merged.values()]
  }

  function retainedAppliedRules(automations: DetectedAutomation[]): DetectedAutomation[] {
    return automations.filter(hasAppliedRules).map(normalizeAppliedRuleVisibility)
  }

  let latest: ScanResult | null = null
  let recoveredInterruptedScan = false
  let recoveredAppliedRuleVisibility = false
  try { latest = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { /* none yet */ }
  if (latest) {
    recoveredAppliedRuleVisibility = [
      ...latest.automations,
      ...(latest.priorAutomations ?? []),
    ].some(automation => hasAppliedRules(automation) && automation.status === 'dismissed')
    latest.automations = latest.automations.map(normalizeAppliedRuleVisibility)
    if (latest.priorAutomations) {
      latest.priorAutomations = latest.priorAutomations.map(normalizeAppliedRuleVisibility)
    }
    const interruptedScan = latest.status === 'running'
    if (interruptedScan) {
      latest.status = 'error'
      latest.finishedAt = new Date().toISOString()
      latest.error = 'The previous history scan was interrupted before it finished. Start a new scan to try again.'
      latest.log.push({ ts: latest.finishedAt, level: 'error', message: latest.error })
      if (latest.log.length > 2000) latest.log.shift()
      recoveredInterruptedScan = true
    }
    for (const a of latest.automations) {
      if (a.status === 'promoting') {
        a.status = 'promotion_failed'
        a.statusDetail = 'Artifact generation was interrupted before it finished.'
      }
    }
    if (latest.generation && !latest.generation.artifactId && !latest.generation.workflowId && !latest.generation.error) {
      const interruptedId = latest.generation.id
      latest.generation = null
      const a = latest.automations.find(candidate => candidate.id === interruptedId)
      if (a) {
        a.status = 'promotion_failed'
        a.statusDetail = 'Artifact generation was interrupted before it finished.'
      }
    }
    if (interruptedScan) {
      latest.priorAutomations = mergeAutomationHistory(latest.priorAutomations ?? [], latest.automations)
      latest.automations = retainedAppliedRules(latest.priorAutomations)
    }
  }
  let running = false
  let persistQueue: Promise<void> = Promise.resolve()
  let promotionJob: Promise<void> = Promise.resolve()
  let persistCounter = 0
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)   // SSE fan-out: many concurrent /stream clients, cleaned up on disconnect

  function persist(): Promise<void> {
    return persistSnapshot(latest)
  }

  function persistSnapshot(value: ScanResult | null): Promise<void> {
    const snapshot = JSON.stringify(value, null, 2)
    const tmp = `${filePath}.${process.pid}.${++persistCounter}.tmp`
    const write = persistQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot)
      await fs.rename(tmp, filePath)
    })
    persistQueue = write.catch(() => undefined)
    return write
  }

  if (recoveredInterruptedScan || recoveredAppliedRuleVisibility) void persist().catch(() => undefined)

  /** Carry terminal user decisions forward onto freshly-detected automations by id. */
  function reconcile(fresh: DetectedAutomation[], prior: DetectedAutomation[]): DetectedAutomation[] {
    const normalizedPrior = mergeAutomationHistory([], prior)
    const priorMap = new Map(normalizedPrior.map(a => [a.id, a]))
    const freshIds = new Set(fresh.map(automation => automation.id))
    const reconciled = fresh.map((a): DetectedAutomation => {
      const was = priorMap.get(a.id)
      const generatedArtifactTier = was?.generatedArtifactTier
        ?? (was?.generatedArtifactId && was.selectedTier && was.selectedTier !== 'rule' ? was.selectedTier : undefined)
        ?? (was?.generatedArtifactId ? 'workflow' : undefined)
      const carried = was ? {
        ...(was.selectedTier ? { selectedTier: was.selectedTier } : {}),
        ...(was.generatedArtifactId ? { generatedArtifactId: was.generatedArtifactId } : {}),
        ...(generatedArtifactTier ? { generatedArtifactTier } : {}),
        ...(was.ruleApplications ? { ruleApplications: was.ruleApplications.map(application => ({ ...application, target: { ...application.target } })) } : {}),
      } : {}
      if (was?.status === 'dismissed') {
        return {
          ...a,
          ...carried,
          status: 'dismissed',
          dismissedFromStatus: was.dismissedFromStatus,
          dismissedFromStatusDetail: was.dismissedFromStatusDetail,
        }
      }
      return was?.status === 'promoted'
        ? { ...a, ...carried, status: 'promoted', ...(was.statusDetail ? { statusDetail: was.statusDetail } : {}) }
        : { ...a, ...carried }
    })
    return [
      ...reconciled,
      ...normalizedPrior
        .filter(automation => hasAppliedRules(automation) && !freshIds.has(automation.id))
        .map(cloneAutomation),
    ]
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
      if (persistedGeneration && !persistedGeneration.artifactId && !persistedGeneration.workflowId && !persistedGeneration.error) return true
      return latest?.automations.some(a => a.status === 'promoting') ?? false
    },
    onLog(cb) { emitter.on('log', cb); return () => emitter.off('log', cb) },
    appendLog(e) {
      const entry: LogEntry = { ts: new Date().toISOString(), ...e }
      if (latest) { latest.log.push(entry); if (latest.log.length > 2000) latest.log.shift() }
      emitter.emit('log', entry)
    },
    async setDiagnostics(d) {
      if (!latest) return
      latest.diagnostics = d
      await persist()
    },
    async runScan(job) {
      if (running) throw new Error('A scan is already running.')
      running = true
      const priorAutomations = mergeAutomationHistory(latest?.priorAutomations ?? [], latest?.automations ?? [])
      latest = {
        status: 'running',
        startedAt: new Date().toISOString(),
        automations: retainedAppliedRules(priorAutomations),
        priorAutomations,
        log: [],
      }
      await persist()
      try {
        const automations = reconcile(await job(), priorAutomations)
        latest = { status: 'done', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), automations, log: latest.log, generation: latest.generation ?? null, diagnostics: latest.diagnostics }
      } catch (err) {
        latest = { status: 'error', startedAt: latest.startedAt, finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : 'scan failed', automations: retainedAppliedRules(priorAutomations), priorAutomations, log: latest?.log ?? [], generation: latest?.generation ?? null, diagnostics: latest?.diagnostics }
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
    async updateAutomation(id, patch) {
      const a = latest?.automations.find(x => x.id === id)
      if (!a) return null
      Object.assign(a, patch)
      await persist()
      return a
    },
    async commitPromotion(id, patch, generation) {
      if (!latest) return null
      const index = latest.automations.findIndex(candidate => candidate.id === id)
      if (index < 0) return null
      const updated = { ...latest.automations[index], ...patch }
      const automations = [...latest.automations]
      automations[index] = updated
      const candidate: ScanResult = { ...latest, automations, generation }
      await persistSnapshot(candidate)
      latest = candidate
      return updated
    },
    async dismiss(id) {
      const a = latest?.automations.find(candidate => candidate.id === id)
      if (!a) return null
      if (hasAppliedRules(a)) throw new Error('Remove every applied rule before dismissing this automation.')
      if (a.status !== 'dismissed' && a.status !== 'promoting') {
        a.dismissedFromStatus = a.status
        if (a.statusDetail) a.dismissedFromStatusDetail = a.statusDetail
        else delete a.dismissedFromStatusDetail
      }
      a.status = 'dismissed'
      delete a.statusDetail
      await persist()
      return a
    },
    async restore(id) {
      const a = latest?.automations.find(candidate => candidate.id === id)
      if (!a) return null
      a.status = a.dismissedFromStatus ?? 'new'
      if (a.dismissedFromStatusDetail) a.statusDetail = a.dismissedFromStatusDetail
      else delete a.statusDetail
      delete a.dismissedFromStatus
      delete a.dismissedFromStatusDetail
      await persist()
      return a
    },
  }
}
