import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RunStatus } from '../run-events.js'

export const RUN_MANIFEST_VERSION = 1 as const

export const MANAGED_RUN_STATES = [
  'claimed',
  'checking_precondition',
  'precondition_failed',
  'preparing',
  'worktree_created',
  'running_setup',
  'spawning',
  'running',
  'paused',
  'resuming',
  'checkpointing',
  'cleaning',
  'completed',
  'failed',
  'aborted',
  'rejecting',
  'rejected',
] as const

export type ManagedRunState = (typeof MANAGED_RUN_STATES)[number]

export const RUN_RESULT_DISPOSITIONS = [
  'unavailable',
  'ready',
  'applying',
  'applied',
  'discarding',
  'discarded',
] as const

export type RunResultDisposition = (typeof RUN_RESULT_DISPOSITIONS)[number]
export type RunResultAction = 'apply' | 'discard'

export interface RunActionError {
  action: RunResultAction
  code: string
  message: string
  at: string
}

export interface RunManifestTransition {
  at: string
  lifecycleState: ManagedRunState
  disposition: RunResultDisposition
}

/**
 * Durable authority for a run started by the CWC harness. JSONL events remain an
 * observational timeline and are intentionally not represented as authority here.
 */
export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION
  source: 'managed'
  runId: string
  workflowId: string
  workflowSkillSlug: string
  triggerId: string
  lifecycleState: ManagedRunState
  completionStatus?: RunStatus
  requestedIsolation: 'worktree' | 'in-place'
  originalCwd: string
  repositoryIdentity?: string
  requestedBaseRef: string
  baseSha?: string
  worktreePath?: string
  branch?: string
  sessionId?: string
  resultSha?: string
  disposition: RunResultDisposition
  appliedSha?: string
  failureReason?: string
  actionError: RunActionError | null
  createdAt: string
  updatedAt: string
  transitions: RunManifestTransition[]
}

export interface CreateRunManifestInput {
  runId: string
  workflowId: string
  workflowSkillSlug: string
  triggerId: string
  requestedIsolation: 'worktree' | 'in-place'
  originalCwd: string
  requestedBaseRef: string
}

export interface RunActionAvailability {
  diff: boolean
  approve: boolean
  reject: boolean
  apply: boolean
  discard: boolean
}

export interface RunManifestTransaction {
  current(): RunManifest
  transition(update: (current: RunManifest) => RunManifest | Promise<RunManifest>): Promise<RunManifest>
}

export interface RunManifestStore {
  create(input: CreateRunManifestInput): Promise<RunManifest>
  read(workflowId: string, runId: string): Promise<RunManifest | null>
  transition(workflowId: string, runId: string, update: (current: RunManifest) => RunManifest | Promise<RunManifest>): Promise<RunManifest>
  withRun<T>(workflowId: string, runId: string, operation: (transaction: RunManifestTransaction) => Promise<T>): Promise<T>
  listWorkflow(workflowId: string): Promise<RunManifest[]>
  listAll(): Promise<RunManifest[]>
}

export class RunManifestError extends Error {}
export class RunManifestNotFoundError extends RunManifestError {}
export class RunManifestConflictError extends RunManifestError {}
export class RunManifestVersionError extends RunManifestError {}
export class RunManifestValidationError extends RunManifestError {}

const SAFE_ID = /^[A-Za-z0-9._-]+$/
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const MAX_ID_LENGTH = 200
const MAX_SHORT_STRING = 1_024
const MAX_PATH_LENGTH = 32_768
const MAX_TRANSITIONS = 10_000

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && value !== '.'
    && value !== '..'
    && SAFE_ID.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireSafeId(value: unknown, field: string): string {
  if (!isSafeIdentifier(value)) {
    throw new RunManifestValidationError(`${field} contains unsafe characters`)
  }
  return value
}

function requireString(value: unknown, field: string, maxLength = MAX_SHORT_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new RunManifestValidationError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string, maxLength = MAX_SHORT_STRING): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field, maxLength)
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field)
  if (!Number.isFinite(Date.parse(timestamp))) throw new RunManifestValidationError(`${field} must be an ISO timestamp`)
  return timestamp
}

function optionalSha(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SHA.test(value)) throw new RunManifestValidationError(`${field} must be a full Git commit SHA`)
  return value
}

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new RunManifestValidationError(`${field} has an unsupported value`)
  }
  return value as T
}

export function isSafeRunIdentifier(value: string): boolean {
  return isSafeIdentifier(value)
}

export function managedRunBranch(workflowSkillSlug: string, runId: string): string {
  requireSafeId(workflowSkillSlug, 'workflowSkillSlug')
  requireSafeId(runId, 'runId')
  return `cwc/${workflowSkillSlug}/${runId}`
}

export function parseRunManifest(raw: unknown): RunManifest {
  if (!isRecord(raw)) throw new RunManifestValidationError('run manifest must be a JSON object')
  if (raw.version !== RUN_MANIFEST_VERSION) {
    throw new RunManifestVersionError(`unsupported run manifest version: ${String(raw.version)}`)
  }
  if (raw.source !== 'managed') throw new RunManifestValidationError('source must be managed')

  const runId = requireSafeId(raw.runId, 'runId')
  const workflowId = requireSafeId(raw.workflowId, 'workflowId')
  const workflowSkillSlug = requireSafeId(raw.workflowSkillSlug, 'workflowSkillSlug')
  const triggerId = requireSafeId(raw.triggerId, 'triggerId')
  const lifecycleState = enumValue(raw.lifecycleState, 'lifecycleState', MANAGED_RUN_STATES)
  const requestedIsolation = enumValue(raw.requestedIsolation, 'requestedIsolation', ['worktree', 'in-place'] as const)
  const disposition = enumValue(raw.disposition, 'disposition', RUN_RESULT_DISPOSITIONS)
  const createdAt = requireTimestamp(raw.createdAt, 'createdAt')
  const updatedAt = requireTimestamp(raw.updatedAt, 'updatedAt')

  let completionStatus: RunStatus | undefined
  if (raw.completionStatus !== undefined) {
    completionStatus = enumValue(raw.completionStatus, 'completionStatus', ['complete', 'escalated', 'aborted', 'error'] as const)
  }

  let actionError: RunActionError | null = null
  if (raw.actionError !== null) {
    if (!isRecord(raw.actionError)) throw new RunManifestValidationError('actionError must be an object or null')
    actionError = {
      action: enumValue(raw.actionError.action, 'actionError.action', ['apply', 'discard'] as const),
      code: requireString(raw.actionError.code, 'actionError.code'),
      message: requireString(raw.actionError.message, 'actionError.message', MAX_PATH_LENGTH),
      at: requireTimestamp(raw.actionError.at, 'actionError.at'),
    }
  }

  if (!Array.isArray(raw.transitions) || raw.transitions.length === 0 || raw.transitions.length > MAX_TRANSITIONS) {
    throw new RunManifestValidationError('transitions must be a non-empty bounded array')
  }
  const transitions = raw.transitions.map((value, index): RunManifestTransition => {
    if (!isRecord(value)) throw new RunManifestValidationError(`transitions[${index}] must be an object`)
    return {
      at: requireTimestamp(value.at, `transitions[${index}].at`),
      lifecycleState: enumValue(value.lifecycleState, `transitions[${index}].lifecycleState`, MANAGED_RUN_STATES),
      disposition: enumValue(value.disposition, `transitions[${index}].disposition`, RUN_RESULT_DISPOSITIONS),
    }
  })

  const lastTransition = transitions[transitions.length - 1]
  if (lastTransition.lifecycleState !== lifecycleState || lastTransition.disposition !== disposition || lastTransition.at !== updatedAt) {
    throw new RunManifestValidationError('latest transition must match the current manifest state')
  }
  if (transitions[0].at !== createdAt) throw new RunManifestValidationError('first transition must match createdAt')

  const branch = optionalString(raw.branch, 'branch', MAX_PATH_LENGTH)
  if (branch !== undefined && branch !== managedRunBranch(workflowSkillSlug, runId)) {
    throw new RunManifestValidationError('branch is not the CWC branch owned by this run')
  }
  if (requestedIsolation === 'in-place' && (raw.worktreePath !== undefined || branch !== undefined || raw.resultSha !== undefined)) {
    throw new RunManifestValidationError('in-place manifests cannot own isolated result fields')
  }

  const resultSha = optionalSha(raw.resultSha, 'resultSha')
  const appliedSha = optionalSha(raw.appliedSha, 'appliedSha')
  if (disposition === 'applied' && (!appliedSha || appliedSha !== resultSha)) {
    throw new RunManifestValidationError('applied manifests require appliedSha to equal resultSha')
  }

  return {
    version: RUN_MANIFEST_VERSION,
    source: 'managed',
    runId,
    workflowId,
    workflowSkillSlug,
    triggerId,
    lifecycleState,
    ...(completionStatus ? { completionStatus } : {}),
    requestedIsolation,
    originalCwd: requireString(raw.originalCwd, 'originalCwd', MAX_PATH_LENGTH),
    ...(optionalString(raw.repositoryIdentity, 'repositoryIdentity', MAX_PATH_LENGTH) ? { repositoryIdentity: optionalString(raw.repositoryIdentity, 'repositoryIdentity', MAX_PATH_LENGTH) } : {}),
    requestedBaseRef: requireString(raw.requestedBaseRef, 'requestedBaseRef', MAX_PATH_LENGTH),
    ...(optionalSha(raw.baseSha, 'baseSha') ? { baseSha: optionalSha(raw.baseSha, 'baseSha') } : {}),
    ...(optionalString(raw.worktreePath, 'worktreePath', MAX_PATH_LENGTH) ? { worktreePath: optionalString(raw.worktreePath, 'worktreePath', MAX_PATH_LENGTH) } : {}),
    ...(branch ? { branch } : {}),
    ...(optionalString(raw.sessionId, 'sessionId', MAX_PATH_LENGTH) ? { sessionId: optionalString(raw.sessionId, 'sessionId', MAX_PATH_LENGTH) } : {}),
    ...(resultSha ? { resultSha } : {}),
    disposition,
    ...(appliedSha ? { appliedSha } : {}),
    ...(optionalString(raw.failureReason, 'failureReason', MAX_PATH_LENGTH) ? { failureReason: optionalString(raw.failureReason, 'failureReason', MAX_PATH_LENGTH) } : {}),
    actionError,
    createdAt,
    updatedAt,
    transitions,
  }
}

function cloneManifest(manifest: RunManifest): RunManifest {
  return JSON.parse(JSON.stringify(manifest)) as RunManifest
}

function manifestKey(workflowId: string, runId: string): string {
  return JSON.stringify([workflowId, runId])
}

function assertImmutableFields(before: RunManifest, after: RunManifest): void {
  for (const field of [
    'version', 'source', 'runId', 'workflowId', 'workflowSkillSlug', 'triggerId',
    'requestedIsolation', 'originalCwd', 'requestedBaseRef', 'createdAt',
  ] as const) {
    if (after[field] !== before[field]) throw new RunManifestValidationError(`${field} cannot change after manifest creation`)
  }
}

function defaultNow(): string {
  return new Date().toISOString()
}

export function isTerminalManifest(manifest: RunManifest): boolean {
  return ['completed', 'failed', 'aborted', 'rejected'].includes(manifest.lifecycleState)
}

export function runActionAvailability(manifest: RunManifest): RunActionAvailability {
  const hasGitAuthority = Boolean(manifest.repositoryIdentity && manifest.baseSha)
  const hasIsolatedResult = manifest.requestedIsolation === 'worktree'
    && Boolean(manifest.branch && manifest.resultSha && manifest.repositoryIdentity && manifest.baseSha)
  return {
    diff: hasGitAuthority && manifest.disposition !== 'discarded',
    approve: manifest.lifecycleState === 'paused' && Boolean(manifest.sessionId),
    reject: manifest.lifecycleState === 'paused',
    apply: manifest.lifecycleState === 'completed'
      && manifest.completionStatus === 'complete'
      && (manifest.disposition === 'ready' || manifest.disposition === 'applying')
      && hasIsolatedResult,
    discard: isTerminalManifest(manifest)
      && (manifest.disposition === 'ready' || manifest.disposition === 'discarding')
      && hasIsolatedResult,
  }
}

export function createRunManifestStore(runsDir: string, options: { now?: () => string } = {}): RunManifestStore {
  const now = options.now ?? defaultNow
  const queues = new Map<string, Promise<void>>()

  function validatePathIds(workflowId: string, runId?: string): void {
    requireSafeId(workflowId, 'workflowId')
    if (runId !== undefined) requireSafeId(runId, 'runId')
  }

  function manifestPath(workflowId: string, runId: string): string {
    validatePathIds(workflowId, runId)
    return path.join(runsDir, workflowId, `${runId}.manifest.json`)
  }

  function serialize<T>(workflowId: string, runId: string, job: () => Promise<T>): Promise<T> {
    const key = manifestKey(workflowId, runId)
    const previous = queues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(job)
    const tail = result.then(() => undefined, () => undefined)
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return result
  }

  async function atomicWrite(manifest: RunManifest): Promise<void> {
    const target = manifestPath(manifest.workflowId, manifest.runId)
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${manifest.runId}.${process.pid}.${randomUUID()}.manifest.tmp`)
    try {
      await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  async function readRaw(workflowId: string, runId: string): Promise<RunManifest | null> {
    const file = manifestPath(workflowId, runId)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new RunManifestValidationError(`run manifest is malformed JSON: ${file}`)
    }
    const manifest = parseRunManifest(parsed)
    if (manifest.workflowId !== workflowId || manifest.runId !== runId) {
      throw new RunManifestValidationError('run manifest identity does not match its path')
    }
    return manifest
  }

  async function runTransaction<T>(workflowId: string, runId: string, operation: (transaction: RunManifestTransaction) => Promise<T>): Promise<T> {
    return serialize(workflowId, runId, async () => {
      let current = await readRaw(workflowId, runId)
      if (!current) throw new RunManifestNotFoundError(`run manifest not found: ${workflowId}/${runId}`)

      const transaction: RunManifestTransaction = {
        current: () => cloneManifest(current!),
        async transition(update) {
          const proposed = await update(cloneManifest(current!))
          assertImmutableFields(current!, proposed)
          const at = now()
          const next = parseRunManifest({
            ...proposed,
            updatedAt: at,
            transitions: [
              ...current!.transitions,
              { at, lifecycleState: proposed.lifecycleState, disposition: proposed.disposition },
            ],
          })
          await atomicWrite(next)
          current = next
          return cloneManifest(next)
        },
      }
      return operation(transaction)
    })
  }

  async function listWorkflow(workflowId: string): Promise<RunManifest[]> {
    validatePathIds(workflowId)
    let files: string[]
    try {
      files = await fs.readdir(path.join(runsDir, workflowId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const manifests: RunManifest[] = []
    for (const file of files.filter(name => name.endsWith('.manifest.json')).sort()) {
      const runId = file.slice(0, -'.manifest.json'.length)
      if (!isSafeRunIdentifier(runId)) continue
      try {
        const manifest = await readRaw(workflowId, runId)
        if (manifest) manifests.push(manifest)
      } catch {
        // A malformed server-owned file must never gain cleanup/Git authority.
      }
    }
    return manifests
  }

  return {
    async create(input) {
      validatePathIds(input.workflowId, input.runId)
      return serialize(input.workflowId, input.runId, async () => {
        if (await readRaw(input.workflowId, input.runId)) {
          throw new RunManifestConflictError(`run manifest already exists: ${input.workflowId}/${input.runId}`)
        }
        const at = now()
        const manifest = parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          source: 'managed',
          ...input,
          lifecycleState: 'claimed',
          disposition: 'unavailable',
          actionError: null,
          createdAt: at,
          updatedAt: at,
          transitions: [{ at, lifecycleState: 'claimed', disposition: 'unavailable' }],
        })
        await atomicWrite(manifest)
        return cloneManifest(manifest)
      })
    },
    read: readRaw,
    transition(workflowId, runId, update) {
      return runTransaction(workflowId, runId, transaction => transaction.transition(update))
    },
    withRun: runTransaction,
    listWorkflow,
    async listAll() {
      let workflowIds: string[]
      try {
        workflowIds = await fs.readdir(runsDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const all: RunManifest[] = []
      for (const workflowId of workflowIds.sort()) {
        if (!isSafeRunIdentifier(workflowId)) continue
        all.push(...await listWorkflow(workflowId))
      }
      return all
    },
  }
}
