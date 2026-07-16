// src/server/api/runs.ts
import { Router, type Response } from 'express'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import { validateRunEvent, type RunEvent } from '../../run-events.js'
import type { RunStore, RunSummary } from '../run-store.js'
import { runWorkflowSkill } from '../workflow-runner.js'
import { fireWorkflow, classifyAndFinish } from '../run-launcher.js'
import {
  applyResultFastForward,
  checkpointWorktree,
  discardResultBranch,
  getDiff,
  getRepositoryIdentity,
  inspectManagedWorktree,
  isGitRepo,
  removeVerifiedWorktree,
  resolveHeadSha,
  verifyManagedResult,
  type ManagedResultAuthority,
} from '../run-isolation.js'
import {
  isSafeRunIdentifier,
  isTerminalManifest,
  runActionAvailability,
  type RunActionError,
  type RunManifest,
  type RunManifestStore,
} from '../run-manifest.js'

export interface RunsRouterOptions {
  store: RunStore
  manifests?: RunManifestStore
  claudeBinPath?: string   // test injection
  worktreesRoot: string
  runsDirPath: string
  skillsDir: string        // ~/.claude/skills — used to verify a workflow is exported before a test run
}

type ManifestLookup =
  | { kind: 'manifest'; manifest: RunManifest }
  | { kind: 'legacy' }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }

class RunActionConflict extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function runsRouter(opts: RunsRouterOptions): Router {
  const { store } = opts
  const manifests = opts.manifests ?? store.manifests
  const router = Router()

  function externalEvent(event: RunEvent): RunEvent {
    const sanitized: RunEvent = {
      runId: event.runId,
      workflowId: event.workflowId,
      workflowSlug: event.workflowSlug,
      type: event.type,
      ts: event.ts,
      source: 'external',
    }
    if (typeof event.nodeId === 'string') sanitized.nodeId = event.nodeId
    if (typeof event.agentSlug === 'string') sanitized.agentSlug = event.agentSlug
    if (typeof event.message === 'string') sanitized.message = event.message
    if (typeof event.artifactPath === 'string') sanitized.artifactPath = event.artifactPath
    if (typeof event.status === 'string') sanitized.status = event.status
    if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) sanitized.costUsd = event.costUsd
    return sanitized
  }

  function validPathIds(workflowId: string, runId: string): boolean {
    return isSafeRunIdentifier(workflowId) && isSafeRunIdentifier(runId)
  }

  async function lookupManifest(workflowId: string, runId: string): Promise<ManifestLookup> {
    try {
      const manifest = await manifests.read(workflowId, runId)
      if (manifest) return { kind: 'manifest', manifest }
    } catch (err) {
      return { kind: 'invalid', message: err instanceof Error ? err.message : 'run manifest is unreadable' }
    }
    return (await store.getEvents(workflowId, runId)) ? { kind: 'legacy' } : { kind: 'missing' }
  }

  function requireManifestResponse(lookup: ManifestLookup, res: Response): RunManifest | null {
    if (lookup.kind === 'manifest') return lookup.manifest
    if (lookup.kind === 'missing') res.status(404).json({ error: 'run not found' })
    else if (lookup.kind === 'legacy') res.status(409).json({ error: 'This legacy run has no server-owned manifest, so CWC cannot perform managed run actions on it.' })
    else res.status(409).json({ error: `The server-owned run manifest is invalid: ${lookup.message}` })
    return null
  }

  function authorityFor(manifest: RunManifest): ManagedResultAuthority | null {
    if (!manifest.repositoryIdentity || !manifest.baseSha || !manifest.branch || !manifest.resultSha) return null
    return {
      destinationCwd: manifest.originalCwd,
      repositoryIdentity: manifest.repositoryIdentity,
      baseSha: manifest.baseSha,
      branch: manifest.branch,
      resultSha: manifest.resultSha,
    }
  }

  function actionError(action: 'apply' | 'discard', code: string, message: string): RunActionError {
    return { action, code, message, at: new Date().toISOString() }
  }

  function sendActionError(res: Response, err: unknown): void {
    if (err instanceof RunActionConflict) {
      res.status(409).json({ error: err.message, code: err.code })
      return
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'managed run action failed' })
  }

  router.post('/events', async (req, res) => {
    const outcome = validateRunEvent(req.body)
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error })
      return
    }
    try {
      // Deliberately observational: this route has no manifest-store write path.
      const accepted = await store.appendExternal(externalEvent(outcome.event))
      if (!accepted) return void res.status(409).json({ error: 'managed run is no longer accepting external events' })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to persist event' })
    }
  })

  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const off = store.onEvent(event => res.write(`data: ${JSON.stringify(event)}\n\n`))
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 30_000)
    req.on('close', () => { off(); clearInterval(heartbeat) })
  })

  router.post('/test', async (req, res) => {
    const { workflowId, workflowSlug, cwd, isolation: isolationBody } = (req.body ?? {}) as {
      workflowId?: string
      workflowSlug?: string
      cwd?: string
      isolation?: 'worktree' | 'in-place'
    }
    if (!workflowId || !workflowSlug || !cwd) {
      res.status(400).json({ error: 'workflowId, workflowSlug, and cwd are required' })
      return
    }
    if (!validPathIds(workflowId, 'run-placeholder') || !isSafeRunIdentifier(workflowSlug)) {
      res.status(400).json({ error: 'workflowId or workflowSlug contains unsafe characters' })
      return
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      res.status(400).json({ error: `working directory does not exist: ${cwd}` })
      return
    }
    const userSkill = path.join(opts.skillsDir, workflowSlug, 'SKILL.md')
    const projectSkill = path.join(cwd, '.claude', 'skills', workflowSlug, 'SKILL.md')
    if (!fs.existsSync(userSkill) && !fs.existsSync(projectSkill)) {
      res.status(400).json({ error: `workflow not exported: no skill found for /${workflowSlug}. Export the workflow first (re-export if you renamed it).` })
      return
    }
    if (store.hasActiveTestRun(workflowId)) {
      res.status(409).json({ error: 'a test run for this workflow is already active' })
      return
    }
    const isolation = isolationBody ?? ((await isGitRepo(cwd)) ? 'worktree' : 'in-place')
    if (isolation !== 'worktree' && isolation !== 'in-place') {
      res.status(400).json({ error: 'isolation must be worktree or in-place' })
      return
    }
    const outcome = await fireWorkflow({
      workflowId,
      workflowSlug,
      cwd,
      isolation,
      trigger: 'manual',
      store,
      manifests,
      worktreesRoot: opts.worktreesRoot,
      binPath: opts.claudeBinPath,
    })
    if (!outcome.fired) {
      res.status(outcome.reason === 'workflow already active' ? 409 : 400).json({ error: outcome.reason })
      return
    }
    res.json({ runId: outcome.runId })
  })

  // Global collections MUST be registered before '/:runId/...'.
  router.get('/paused', async (_req, res) => {
    const all: RunSummary[] = []
    let dirs: string[] = []
    try { dirs = await fsPromises.readdir(opts.runsDirPath) } catch { /* none yet */ }
    for (const workflowId of dirs) {
      for (const run of await store.listRuns(workflowId, manifests)) if (run.status === 'paused') all.push(run)
    }
    res.json(all.sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)))
  })

  router.get('/recent', async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
    const all: RunSummary[] = []
    let dirs: string[] = []
    try { dirs = await fsPromises.readdir(opts.runsDirPath) } catch { /* none yet */ }
    for (const workflowId of dirs) all.push(...await store.listRuns(workflowId, manifests))
    all.sort((a, b) => Date.parse(b.lastEventAt ?? b.startedAt) - Date.parse(a.lastEventAt ?? a.startedAt))
    res.json(all.slice(0, limit))
  })

  router.post('/:runId/stop', (req, res) => {
    if (!isSafeRunIdentifier(req.params.runId)) return void res.status(400).json({ error: 'runId contains unsafe characters' })
    if (!store.stopRun(req.params.runId)) return void res.status(404).json({ error: 'no active test run with that id' })
    res.json({ stopped: true })
  })

  router.get('/:runId/events', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) return void res.status(400).json({ error: 'workflowId query param is required' })
    if (!validPathIds(workflowId, req.params.runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    const events = await store.getEvents(workflowId, req.params.runId)
    if (events === null) return void res.status(404).json({ error: 'run not found' })
    res.json(events)
  })

  router.get('/:runId/diff', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    if (!validPathIds(workflowId, req.params.runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    const lookup = await lookupManifest(workflowId, req.params.runId)
    if (lookup.kind === 'missing') return void res.status(404).json({ error: 'run not found' })
    if (lookup.kind === 'invalid') return void res.status(409).json({ error: `The server-owned run manifest is invalid: ${lookup.message}` })
    if (lookup.kind === 'legacy') {
      return void res.json({ diff: null, status: null, branch: null, error: 'This legacy run has no server-owned manifest, so its Git metadata cannot be trusted.' })
    }

    const manifest = lookup.manifest
    const branch = manifest.branch ?? null
    if (!runActionAvailability(manifest).diff || !manifest.repositoryIdentity || !manifest.baseSha) {
      return void res.json({ diff: null, status: null, branch, error: 'This managed run has no verified Git result to display.' })
    }
    try {
      if (manifest.worktreePath && fs.existsSync(manifest.worktreePath)) {
        if (!manifest.branch) return void res.json({ diff: null, status: null, branch, error: 'The run manifest does not own a worktree branch.' })
        const inspection = await inspectManagedWorktree(manifest.originalCwd, manifest.repositoryIdentity, manifest.worktreePath, manifest.branch)
        if (!inspection.ok) return void res.json({ diff: null, status: null, branch, error: inspection.message })
        return void res.json({ ...await getDiff(manifest.worktreePath, manifest.baseSha), branch })
      }
      if (manifest.branch && manifest.resultSha) {
        const authority = authorityFor(manifest)!
        const verified = await verifyManagedResult(authority)
        if (!verified.ok) return void res.json({ diff: null, status: null, branch, error: verified.message })
        return void res.json({ ...await getDiff(manifest.originalCwd, manifest.baseSha, manifest.branch), branch })
      }
      if (manifest.requestedIsolation === 'in-place') {
        const identity = await getRepositoryIdentity(manifest.originalCwd)
        if (identity !== manifest.repositoryIdentity) return void res.json({ diff: null, status: null, branch, error: 'The original checkout no longer matches the managed repository.' })
        return void res.json({ ...await getDiff(manifest.originalCwd, manifest.baseSha), branch })
      }
      return void res.json({ diff: null, status: null, branch, error: 'The managed result is no longer available.' })
    } catch (err) {
      res.json({ diff: null, status: null, branch, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/:runId/approve', async (req, res) => {
    const { workflowId, note } = (req.body ?? {}) as { workflowId?: string; note?: string }
    const runId = req.params.runId
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    if (!validPathIds(workflowId, runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    if (store.isActive(runId)) return void res.status(409).json({ error: 'run is still finishing — try again in a moment' })
    if (store.hasActiveTestRun(workflowId)) return void res.status(409).json({ error: 'a run for this workflow is already active' })
    if (!store.registerRun(runId, workflowId, () => { /* placeholder until resume spawns */ })) {
      return void res.status(409).json({ error: 'the workflow is active or reserved by another operation' })
    }
    const bail = async (code: number, error: string) => {
      store.releaseRun(runId)
      res.status(code).json({ error })
    }

    const lookup = await lookupManifest(workflowId, runId)
    const initial = requireManifestResponse(lookup, res)
    if (!initial) {
      store.releaseRun(runId)
      return
    }

    let manifest: RunManifest
    try {
      manifest = await manifests.withRun(workflowId, runId, async transaction => {
        const current = transaction.current()
        if (current.lifecycleState !== 'paused') throw new RunActionConflict('not_paused', 'run is not paused')
        if (!current.sessionId) throw new RunActionConflict('not_resumable', 'cannot resume this run from CWC because it has no managed resumable session')
        if (current.requestedIsolation === 'worktree') {
          if (!current.repositoryIdentity || !current.worktreePath || !current.branch || !current.baseSha) {
            throw new RunActionConflict('manifest_incomplete', 'the paused run manifest is missing worktree authority')
          }
          const inspected = await inspectManagedWorktree(current.originalCwd, current.repositoryIdentity, current.worktreePath, current.branch)
          if (!inspected.ok) throw new RunActionConflict(inspected.code, inspected.message)
        }
        return transaction.transition(value => ({ ...value, lifecycleState: 'resuming', failureReason: undefined }))
      })
    } catch (err) {
      store.releaseRun(runId)
      if (err instanceof RunActionConflict) return void res.status(409).json({ error: err.message, code: err.code })
      return void res.status(500).json({ error: err instanceof Error ? err.message : 'could not claim the paused run' })
    }

    const runCwd = manifest.worktreePath ?? manifest.originalCwd
    const worktree = manifest.requestedIsolation === 'worktree' && manifest.worktreePath && manifest.branch && manifest.baseSha
      ? { worktreePath: manifest.worktreePath, branch: manifest.branch, baseSha: manifest.baseSha }
      : null
    const prompt = `Approved — continue the workflow from the gate.${note ? `\nNote from the reviewer: ${note}` : ''}`
    try {
      await store.append({
        runId,
        workflowId,
        workflowSlug: manifest.workflowSkillSlug,
        type: 'run_started',
        ts: new Date().toISOString(),
        source: 'test',
        message: 'Run resumed after approval',
      })
    } catch {
      await manifests.transition(workflowId, runId, current => ({ ...current, lifecycleState: 'paused', failureReason: 'could not record the run resume' })).catch(() => {})
      return void await bail(500, 'could not record the run resume')
    }

    let resumed
    try {
      resumed = runWorkflowSkill({
        slug: manifest.workflowSkillSlug,
        runId,
        cwd: runCwd,
        binPath: opts.claudeBinPath,
        resume: manifest.sessionId,
        promptOverride: prompt,
      })
    } catch {
      await manifests.transition(workflowId, runId, current => ({ ...current, lifecycleState: 'paused', failureReason: 'could not resume the workflow process' })).catch(() => {})
      return void await bail(500, 'could not resume the workflow process')
    }
    const { stop, done } = resumed
    store.registerRun(runId, workflowId, stop)
    await manifests.transition(workflowId, runId, current => ({ ...current, lifecycleState: 'running' }))
    void done.then(result => classifyAndFinish({
      workflowId,
      workflowSlug: manifest.workflowSkillSlug,
      cwd: manifest.originalCwd,
      isolation: manifest.requestedIsolation,
      trigger: manifest.triggerId,
      store,
      manifests,
      worktreesRoot: opts.worktreesRoot,
      runId,
      wt: worktree,
      result,
    }))
    res.json({ resumed: true })
  })

  router.post('/:runId/reject', async (req, res) => {
    const { workflowId, note } = (req.body ?? {}) as { workflowId?: string; note?: string }
    const runId = req.params.runId
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    if (!validPathIds(workflowId, runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    if (store.isActive(runId)) return void res.status(409).json({ error: 'run is still finishing — try again in a moment' })
    if (store.hasActiveTestRun(workflowId)) return void res.status(409).json({ error: 'a run for this workflow is already active' })
    if (!store.registerRun(runId, workflowId, () => {})) {
      return void res.status(409).json({ error: 'the workflow is active or reserved by another operation' })
    }
    try {
      const lookup = await lookupManifest(workflowId, runId)
      const initial = requireManifestResponse(lookup, res)
      if (!initial) return

      const rejected = await manifests.withRun(workflowId, runId, async transaction => {
        let manifest = transaction.current()
        if (manifest.lifecycleState !== 'paused') throw new RunActionConflict('not_paused', 'run is not paused')
        if (manifest.requestedIsolation === 'in-place') {
          return transaction.transition(current => ({
            ...current,
            lifecycleState: 'rejected',
            completionStatus: 'aborted',
            disposition: 'unavailable',
            failureReason: note ? `Rejected by reviewer: ${note}` : 'Rejected by reviewer',
          }))
        }
        if (!manifest.repositoryIdentity || !manifest.worktreePath || !manifest.branch || !manifest.baseSha) {
          throw new RunActionConflict('manifest_incomplete', 'the paused run manifest is missing worktree authority')
        }
        try {
          await checkpointWorktree(manifest.worktreePath, runId)
        } catch (err) {
          throw new RunActionConflict(
            'checkpoint_failed',
            `CWC could not checkpoint the paused run before rejection, so the worktree was retained: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const inspected = await inspectManagedWorktree(manifest.originalCwd, manifest.repositoryIdentity, manifest.worktreePath, manifest.branch)
        if (!inspected.ok) throw new RunActionConflict(inspected.code, inspected.message)
        manifest = await transaction.transition(current => ({ ...current, lifecycleState: 'rejecting', resultSha: inspected.resultSha }))
        const removed = await removeVerifiedWorktree(manifest.originalCwd, manifest.repositoryIdentity!, manifest.worktreePath!, manifest.branch!, inspected.resultSha)
        if (!removed.ok) {
          await transaction.transition(current => ({ ...current, lifecycleState: 'paused', failureReason: removed.message }))
          throw new RunActionConflict(removed.code, removed.message)
        }
        const authority = authorityFor(manifest)
        if (!authority) throw new RunActionConflict('manifest_incomplete', 'the run result authority is incomplete after worktree cleanup')
        const discarded = await discardResultBranch(authority)
        if (!discarded.ok) {
          await transaction.transition(current => ({
            ...current,
            lifecycleState: 'failed',
            completionStatus: 'error',
            disposition: 'ready',
            failureReason: discarded.message,
          }))
          throw new RunActionConflict(discarded.code, discarded.message)
        }
        return transaction.transition(current => ({
          ...current,
          lifecycleState: 'rejected',
          completionStatus: 'aborted',
          disposition: 'discarded',
          failureReason: note ? `Rejected by reviewer: ${note}` : 'Rejected by reviewer',
        }))
      })

      await store.append({
        runId,
        workflowId,
        workflowSlug: rejected.workflowSkillSlug,
        type: 'run_completed',
        ts: new Date().toISOString(),
        status: 'aborted',
        source: 'test',
        message: `Rejected by reviewer${note ? `: ${note}` : ''}`,
      })
      res.json({ rejected: true })
    } catch (err) {
      sendActionError(res, err)
    } finally {
      store.releaseRun(runId)
    }
  })

  router.post('/:runId/apply', async (req, res) => {
    const { workflowId } = (req.body ?? {}) as { workflowId?: string }
    const runId = req.params.runId
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    if (!validPathIds(workflowId, runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    const lookup = await lookupManifest(workflowId, runId)
    if (!requireManifestResponse(lookup, res)) return

    try {
      const applied = await manifests.withRun(workflowId, runId, async transaction => {
        let manifest = transaction.current()
        if (manifest.disposition === 'applied') throw new RunActionConflict('already_applied', 'This result has already been applied.')
        if (manifest.disposition === 'discarded' || manifest.disposition === 'discarding') {
          throw new RunActionConflict('result_discarded', 'This result is discarded or currently being discarded and cannot be applied.')
        }
        if (manifest.lifecycleState !== 'completed' || manifest.completionStatus !== 'complete' || manifest.requestedIsolation !== 'worktree') {
          throw new RunActionConflict('not_applicable', 'Apply is available only for a successful, completed isolated run.')
        }
        const authority = authorityFor(manifest)
        if (!authority) throw new RunActionConflict('manifest_incomplete', 'The manifest does not contain a preserved isolated result.')

        if (manifest.disposition === 'applying') {
          let head: string | null = null
          try { head = await resolveHeadSha(manifest.originalCwd) } catch { /* handled by preflight */ }
          if (head === manifest.resultSha) {
            const verified = await verifyManagedResult(authority)
            if (!verified.ok) {
              await transaction.transition(current => ({ ...current, actionError: actionError('apply', verified.code, verified.message) }))
              throw new RunActionConflict(verified.code, verified.message)
            }
            return transaction.transition(current => ({ ...current, disposition: 'applied', appliedSha: current.resultSha, actionError: null }))
          }
          if (head !== manifest.baseSha) {
            const message = 'Apply was interrupted and the destination no longer matches either the recorded base or result. Inspect the checkout before taking another action.'
            await transaction.transition(current => ({ ...current, actionError: actionError('apply', 'interrupted_apply', message) }))
            throw new RunActionConflict('interrupted_apply', message)
          }
        } else if (manifest.disposition !== 'ready') {
          throw new RunActionConflict('result_unavailable', 'This run has no result that is ready to apply.')
        } else {
          manifest = await transaction.transition(current => ({ ...current, disposition: 'applying', actionError: null }))
        }

        const result = await applyResultFastForward(authority)
        if (!result.ok) {
          let head: string | null = null
          try { head = await resolveHeadSha(manifest.originalCwd) } catch { /* preserve applying on uncertainty */ }
          if (head === manifest.resultSha) {
            return transaction.transition(current => ({ ...current, disposition: 'applied', appliedSha: current.resultSha, actionError: null }))
          }
          const nextDisposition = head === manifest.baseSha ? 'ready' as const : 'applying' as const
          await transaction.transition(current => ({ ...current, disposition: nextDisposition, actionError: actionError('apply', result.code, result.message) }))
          throw new RunActionConflict(result.code, result.message)
        }
        return transaction.transition(current => ({ ...current, disposition: 'applied', appliedSha: result.appliedSha, actionError: null }))
      })
      res.json({ applied: true, disposition: applied.disposition, appliedSha: applied.appliedSha })
    } catch (err) {
      sendActionError(res, err)
    }
  })

  router.post('/:runId/discard', async (req, res) => {
    const { workflowId, confirmed } = (req.body ?? {}) as { workflowId?: string; confirmed?: boolean }
    const runId = req.params.runId
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    if (confirmed !== true) return void res.status(400).json({ error: 'Discard requires explicit confirmation.' })
    if (!validPathIds(workflowId, runId)) return void res.status(400).json({ error: 'workflowId or runId contains unsafe characters' })
    const lookup = await lookupManifest(workflowId, runId)
    if (!requireManifestResponse(lookup, res)) return

    try {
      const discarded = await manifests.withRun(workflowId, runId, async transaction => {
        let manifest = transaction.current()
        if (manifest.disposition === 'discarded') throw new RunActionConflict('already_discarded', 'This result has already been discarded.')
        if (manifest.disposition === 'applied' || manifest.disposition === 'applying') {
          throw new RunActionConflict('result_applied', 'An applied or currently applying result cannot be discarded.')
        }
        if (!isTerminalManifest(manifest) || manifest.requestedIsolation !== 'worktree') {
          throw new RunActionConflict('not_discardable', 'Discard is available only for a terminal isolated result.')
        }
        const authority = authorityFor(manifest)
        if (!authority) throw new RunActionConflict('manifest_incomplete', 'The manifest does not contain a preserved isolated result.')
        const recovering = manifest.disposition === 'discarding'
        if (!recovering && manifest.disposition !== 'ready') {
          throw new RunActionConflict('result_unavailable', 'This run has no result that is ready to discard.')
        }
        if (!recovering) manifest = await transaction.transition(current => ({ ...current, disposition: 'discarding', actionError: null }))

        const result = await discardResultBranch(authority)
        if (!result.ok) {
          if (recovering && result.code === 'branch_missing') {
            return transaction.transition(current => ({ ...current, disposition: 'discarded', actionError: null }))
          }
          await transaction.transition(current => ({ ...current, disposition: 'ready', actionError: actionError('discard', result.code, result.message) }))
          throw new RunActionConflict(result.code, result.message)
        }
        return transaction.transition(current => ({ ...current, disposition: 'discarded', actionError: null }))
      })
      res.json({ discarded: true, disposition: discarded.disposition, resultSha: discarded.resultSha })
    } catch (err) {
      sendActionError(res, err)
    }
  })

  router.get('/', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) return void res.status(400).json({ error: 'workflowId query param is required' })
    if (!isSafeRunIdentifier(workflowId)) return void res.status(400).json({ error: 'workflowId contains unsafe characters' })
    res.json(await store.listRuns(workflowId, manifests))
  })

  return router
}
