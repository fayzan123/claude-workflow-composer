// src/server/run-launcher.ts
import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { RunStore } from './run-store.js'
import type { RunEvent, RunStatus } from '../run-events.js'
import { runWorkflowSkill, type WorkflowRunResult } from './workflow-runner.js'
import {
  checkpointWorktree,
  createWorktree,
  discardResultBranch,
  getRepositoryIdentity,
  inspectManagedWorktree,
  isGitRepo,
  removeWorktree,
  removeVerifiedWorktree,
  resolveBaseSha,
  verifyManagedResult,
  type ManagedResultAuthority,
  type WorktreeInfo,
} from './run-isolation.js'
import type { RunManifest, RunManifestStore } from './run-manifest.js'
import { killProcessTree } from './process-tree.js'
import {
  OwnedExportedAgentCollisionError,
  OwnedExportedAgentDeclarationError,
  OwnedExportedAgentDeploymentError,
  OwnedExportedAgentReferenceError,
  resolveExportedAgentBindings,
  resolveOwnedExportedSkill,
  sameExportedAgentBindings,
  sameOwnedExportedSkill,
  type ExportedAgentBinding,
  type OwnedExportedSkill,
} from './exported-skill.js'
import { withExportTargetLease } from '../export/target-lease.js'
import {
  cleanupRunSkillBinding,
  createRunSkillBinding,
  type RunSkillBinding,
} from './run-skill-binding.js'
import type { RunningWorkflow } from './workflow-runner.js'

export interface FireOptions {
  workflowId: string
  workflowSlug: string
  cwd: string
  isolation: 'worktree' | 'in-place'
  trigger: string                 // trigger id or 'manual'
  store: RunStore
  manifests?: RunManifestStore    // defaults to the filesystem store owned by RunStore
  worktreesRoot: string
  skillsDir?: string
  baseRef?: string                // default 'HEAD'
  precondition?: string
  setupCommand?: string
  payload?: string                // webhook body, already truncated/formatted by caller
  runId?: string                  // test injection
  binPath?: string                // test injection
  env?: Record<string, string>    // test injection (passed to the child)
  launchGroupId?: string          // one trigger delivery may intentionally fan out to many targets
  beforeSpawn?: () => Promise<void> // test injection at the export-lease boundary
}

export type FireOutcome =
  | { fired: false; reason: string }
  | { fired: true; runId: string; settled: Promise<void> }

export function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const timedOutMessage = `command timed out after ${Math.round(timeoutMs / 1000)}s`
    let timedOut = false
    // exec, not execFile('cmd'/'sh', ..., command): on Windows, execFile lets Node escape
    // embedded double quotes in the command as \" — which cmd.exe does not understand, so
    // any quoted path in a precondition/setup command breaks. exec passes the raw command
    // line to the platform shell verbatim (cmd /d /s /c on win32, sh -c elsewhere).
    const child = exec(command, { cwd, maxBuffer: 1024 * 1024 }, onExit)
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    function onExit(err: Error | null, stdout: string | Buffer, stderr: string | Buffer): void {
      clearTimeout(timer)
      const output = (stderr?.toString() || stdout?.toString() || '').trim()
      resolve({ ok: !err && !timedOut, output: timedOut ? (output ? `${timedOutMessage}: ${output}` : timedOutMessage) : output })
    }
  })
}

function terminalState(status: WorkflowRunResult['status']): 'completed' | 'failed' | 'aborted' {
  if (status === 'complete') return 'completed'
  return status === 'aborted' ? 'aborted' : 'failed'
}

function completionStatus(status: WorkflowRunResult['status']): RunStatus {
  return status
}

function resultAuthority(manifest: RunManifest): ManagedResultAuthority | null {
  if (!manifest.repositoryIdentity || !manifest.baseSha || !manifest.branch || !manifest.resultSha) return null
  return {
    destinationCwd: manifest.originalCwd,
    repositoryIdentity: manifest.repositoryIdentity,
    baseSha: manifest.baseSha,
    branch: manifest.branch,
    resultSha: manifest.resultSha,
  }
}

function agentDeploymentFailureReason(err: OwnedExportedAgentDeploymentError): string {
  if (err instanceof OwnedExportedAgentCollisionError) return 'agent deployment collision'
  if (err instanceof OwnedExportedAgentDeclarationError) return 'workflow must be re-exported'
  if (err instanceof OwnedExportedAgentReferenceError) return 'agent reference unavailable'
  return 'agent not exported'
}

async function transitionFailure(
  manifests: RunManifestStore,
  workflowId: string,
  runId: string,
  reason: string,
  status: RunStatus = 'error',
): Promise<void> {
  await manifests.transition(workflowId, runId, manifest => ({
    ...manifest,
    lifecycleState: status === 'aborted' ? 'aborted' : 'failed',
    completionStatus: status,
    disposition: 'unavailable',
    failureReason: reason,
    actionError: null,
  }))
}

export async function fireWorkflow(opts: FireOptions): Promise<FireOutcome> {
  const now = () => new Date().toISOString()
  const runId = opts.runId ?? `run-${randomUUID().slice(0, 13)}`
  const manifests = opts.manifests ?? opts.store.manifests
  const requestedBaseRef = opts.baseRef?.trim() || 'HEAD'
  if (!opts.store.registerRun(runId, opts.workflowId, () => { /* launch placeholder */ }, opts.launchGroupId)) {
    return { fired: false, reason: 'workflow already active' }
  }

  try {
    await manifests.create({
      runId,
      workflowId: opts.workflowId,
      workflowSkillSlug: opts.workflowSlug,
      triggerId: opts.trigger,
      requestedIsolation: opts.isolation,
      originalCwd: opts.cwd,
      requestedBaseRef,
    })
  } catch (err) {
    opts.store.releaseRun(runId)
    return { fired: false, reason: `run manifest: ${err instanceof Error ? err.message : String(err)}` }
  }

  const skip = async (reason: string, lifecycleState: 'precondition_failed' | 'failed' = 'failed'): Promise<FireOutcome> => {
    await manifests.transition(opts.workflowId, runId, manifest => ({
      ...manifest,
      lifecycleState,
      completionStatus: 'error',
      failureReason: reason,
      disposition: 'unavailable',
    })).catch(() => {})
    opts.store.releaseRun(runId)
    return { fired: false, reason }
  }

  let wt: WorktreeInfo | null = null
  let expectedSkill: OwnedExportedSkill | null = null
  let expectedAgents: ExportedAgentBinding[] = []
  let runtimeSkillAtBoundary: OwnedExportedSkill | null = null
  let runtimeAgentsAtBoundary: ExportedAgentBinding[] = []
  try {
    // The skill may live in the user scope OR the target project's .claude/skills —
    // project-scoped exports are first-class, and `claude` resolves them from the run cwd.
    if (opts.skillsDir) {
      expectedSkill = await resolveOwnedExportedSkill({
        artifactId: opts.workflowId,
        skillSlug: opts.workflowSlug,
        userSkillsDir: opts.skillsDir,
        projectDir: opts.cwd,
      })
      if (!expectedSkill) return await skip('skill not exported')
      try {
        expectedAgents = await resolveExportedAgentBindings({
          artifactId: opts.workflowId,
          skillContent: expectedSkill.content,
          userAgentsDir: path.join(path.dirname(opts.skillsDir), 'agents'),
          projectDir: opts.cwd,
        })
      } catch (err) {
        if (err instanceof OwnedExportedAgentDeploymentError) {
          return await skip(agentDeploymentFailureReason(err))
        }
        throw err
      }
    }

    if (opts.precondition) {
      await manifests.transition(opts.workflowId, runId, manifest => ({ ...manifest, lifecycleState: 'checking_precondition' }))
      const precondition = await runShellCommand(opts.precondition, opts.cwd, 60_000)
      if (!precondition.ok) return await skip('precondition', 'precondition_failed')
    }

    await manifests.transition(opts.workflowId, runId, manifest => ({ ...manifest, lifecycleState: 'preparing' }))
    const git = await isGitRepo(opts.cwd)
    let baseSha: string | undefined
    let repositoryIdentity: string | undefined
    if (opts.isolation === 'worktree') {
      if (!git) return await skip('not a git repo')
      try {
        repositoryIdentity = await getRepositoryIdentity(opts.cwd)
        wt = await createWorktree(opts.cwd, opts.workflowSlug, runId, requestedBaseRef, opts.worktreesRoot)
        baseSha = wt.baseSha
        await manifests.transition(opts.workflowId, runId, manifest => ({
          ...manifest,
          lifecycleState: 'worktree_created',
          repositoryIdentity,
          baseSha,
          worktreePath: wt!.worktreePath,
          branch: wt!.branch,
        }))
      } catch (err) {
        return await skip(`worktree: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else if (git) {
      repositoryIdentity = await getRepositoryIdentity(opts.cwd)
      baseSha = await resolveBaseSha(opts.cwd, 'HEAD').catch(() => undefined)
      await manifests.transition(opts.workflowId, runId, manifest => ({
        ...manifest,
        repositoryIdentity,
        ...(baseSha ? { baseSha } : {}),
      }))
    }
    const runCwd = wt?.worktreePath ?? opts.cwd

    const started: RunEvent = {
      runId,
      workflowId: opts.workflowId,
      workflowSlug: opts.workflowSlug,
      type: 'run_started',
      ts: now(),
      source: 'test',
      trigger: opts.trigger,
      cwd: opts.cwd,
      baseSha,
      ...(wt ? { worktreePath: wt.worktreePath, branch: wt.branch } : {}),
      message: opts.trigger === 'manual' ? 'Test run started from CWC' : `Fired by trigger ${opts.trigger}`,
    }
    const emit = (event: RunEvent) => opts.store.append(event).catch(() => { /* teardown race */ })

    const rejectPreparedRun = async (reason: string): Promise<FireOutcome> => {
      if (!wt) return await skip(reason)
      const preparedWorktree = wt
      let checkpointed: boolean
      try {
        checkpointed = await checkpointWorktree(preparedWorktree.worktreePath, runId)
      } catch (err) {
        const message = `${reason}; CWC could not checkpoint the prepared worktree, so it was retained at ${preparedWorktree.worktreePath}: ${err instanceof Error ? err.message : String(err)}`
        await emit(started)
        await transitionFailure(manifests, opts.workflowId, runId, message).catch(() => {})
        await emit({
          runId,
          workflowId: opts.workflowId,
          workflowSlug: opts.workflowSlug,
          type: 'run_completed',
          ts: now(),
          status: 'error',
          source: 'test',
          message,
        })
        opts.store.releaseRun(runId)
        return { fired: false, reason: message }
      }
      if (checkpointed) {
        await emit(started)
        await classifyAndFinish({
          ...opts,
          runId,
          wt: preparedWorktree,
          result: { status: 'error', message: reason },
        })
        wt = null
        return { fired: false, reason }
      }
      try {
        await removeWorktree(opts.cwd, preparedWorktree.worktreePath, preparedWorktree.branch, { keepBranch: false })
        wt = null
      } catch (err) {
        return await skip(`${reason}; the unused worktree was retained: ${err instanceof Error ? err.message : String(err)}`)
      }
      return await skip(reason)
    }

    const verifyDeployment = async (): Promise<FireOutcome | null> => {
      if (!opts.skillsDir) return null
      const runtimeSkill = await resolveOwnedExportedSkill({
        artifactId: opts.workflowId,
        skillSlug: opts.workflowSlug,
        userSkillsDir: opts.skillsDir,
        projectDir: opts.cwd,
      })
      let runtimeAgents: ExportedAgentBinding[] = []
      try {
        runtimeAgents = runtimeSkill
          ? await resolveExportedAgentBindings({
              artifactId: opts.workflowId,
              skillContent: runtimeSkill.content,
              userAgentsDir: path.join(path.dirname(opts.skillsDir), 'agents'),
              projectDir: opts.cwd,
            })
          : []
      } catch (err) {
        if (err instanceof OwnedExportedAgentDeploymentError) {
          return await rejectPreparedRun(agentDeploymentFailureReason(err))
        }
        throw err
      }
      if (!expectedSkill || !sameOwnedExportedSkill(expectedSkill, runtimeSkill)
        || !sameExportedAgentBindings(expectedAgents, runtimeAgents)) {
        return await rejectPreparedRun('skill not exported')
      }
      runtimeSkillAtBoundary = runtimeSkill
      runtimeAgentsAtBoundary = runtimeAgents
      return null
    }

    // Re-resolve from the selected deployment target. Project exports are commonly
    // untracked and therefore absent from a fresh worktree; the private plugin is
    // what carries their verified skill/bespoke-agent bytes into the run.
    const runtimeSkillFailure = await verifyDeployment()
    if (runtimeSkillFailure) return runtimeSkillFailure

    if (opts.setupCommand) {
      await manifests.transition(opts.workflowId, runId, manifest => ({ ...manifest, lifecycleState: 'running_setup' }))
      const setup = await runShellCommand(opts.setupCommand, runCwd, 600_000)
      if (!setup.ok) {
        await emit(started)
        await classifyAndFinish({
          ...opts,
          runId,
          wt,
          result: { status: 'error', message: `setupCommand failed: ${setup.output.slice(0, 2000)}` },
        })
        return { fired: true, runId, settled: Promise.resolve() }
      }

      // Setup is arbitrary shell with permission to alter either export scope, so the
      // deployment must be re-verified after it runs. Without a setup command nothing
      // ran since the check above, and bindAndSpawn re-verifies at the lease boundary.
      const postSetupSkillFailure = await verifyDeployment()
      if (postSetupSkillFailure) return postSetupSkillFailure
    }

    await manifests.transition(opts.workflowId, runId, manifest => ({ ...manifest, lifecycleState: 'spawning' }))
    const bindAndSpawn = async (): Promise<FireOutcome | {
      running: RunningWorkflow
      binding: RunSkillBinding | null
    }> => {
      const finalSkillFailure = await verifyDeployment()
      if (finalSkillFailure) return finalSkillFailure
      let binding: RunSkillBinding | null = null
      try {
        if (opts.skillsDir) {
          if (!runtimeSkillAtBoundary) throw new Error('The verified skill binding is unavailable.')
          binding = await createRunSkillBinding({
            root: opts.worktreesRoot,
            runId,
            workflowId: opts.workflowId,
            skillSlug: opts.workflowSlug,
            skillContent: runtimeSkillAtBoundary.content,
            skillContentHash: runtimeSkillAtBoundary.contentHash,
            agents: runtimeAgentsAtBoundary,
          })
          await manifests.transition(opts.workflowId, runId, manifest => ({
            ...manifest,
            runtimeBinding: binding!.authority,
          }))
        }
        await emit(started)
        await opts.beforeSpawn?.()
        const invocationSlug = binding?.invocationSlug ?? opts.workflowSlug
        const prompt = `/${invocationSlug}\nUse run id ${runId} when logging run events.` + (opts.payload ? `\nTrigger payload:\n${opts.payload}` : '')
        return {
          running: runWorkflowSkill({
            slug: opts.workflowSlug,
            runId,
            cwd: runCwd,
            binPath: opts.binPath,
            promptOverride: prompt,
            env: opts.env,
            ...(binding ? { pluginDir: binding.pluginDir } : {}),
          }),
          binding,
        }
      } catch (err) {
        await binding?.cleanup()
        throw err
      }
    }
    const launched = opts.skillsDir
      ? await withExportTargetLease([
          path.dirname(opts.skillsDir),
          opts.skillsDir,
          path.join(opts.cwd, '.claude'),
          path.join(opts.cwd, '.claude', 'skills'),
          path.join(runCwd, '.claude'),
          path.join(runCwd, '.claude', 'skills'),
        ], bindAndSpawn)
      : await bindAndSpawn()
    if ('fired' in launched) return launched
    const { stop } = launched.running
    opts.store.registerRun(runId, opts.workflowId, stop)
    try {
      await manifests.transition(opts.workflowId, runId, manifest => ({ ...manifest, lifecycleState: 'running' }))
    } catch (err) {
      stop()
      await launched.running.done.catch(() => undefined)
      await launched.binding?.cleanup()
      throw err
    }
    // Classification decides whether a successful process exit is terminal or a
    // gate pause. Paused sessions retain the exact plugin for a later resume.
    const settled = launched.running.done.then(result => classifyAndFinish({
      ...opts,
      runId,
      wt,
      result,
      runtimeBinding: launched.binding ?? undefined,
    }))
    return { fired: true, runId, settled }
  } catch (err) {
    const reason = `launch failed: ${err instanceof Error ? err.message : String(err)}`
    await transitionFailure(manifests, opts.workflowId, runId, reason).catch(() => {})
    opts.store.releaseRun(runId)
    throw err
  }
}

/**
 * On server start, only a valid manifest can authorize orphan cleanup. Unknown,
 * legacy, malformed, active, paused, and checkpoint-failed directories are retained.
 */
export async function sweepOrphanWorktrees(
  store: RunStore,
  _runsDirPath: string,
  worktreesRoot: string,
  manifestStore: RunManifestStore = store.manifests,
): Promise<void> {
  const expectedRoot = path.resolve(worktreesRoot)
  const cleanupTerminalBinding = async (manifest: RunManifest): Promise<void> => {
    if (!manifest.runtimeBinding || !['completed', 'failed', 'aborted', 'rejected'].includes(manifest.lifecycleState)) return
    await cleanupRunSkillBinding({
      root: worktreesRoot,
      workflowId: manifest.workflowId,
      runId: manifest.runId,
      skillSlug: manifest.workflowSkillSlug,
      authority: manifest.runtimeBinding,
    })
  }
  for (const initial of await manifestStore.listAll()) {
    await cleanupTerminalBinding(initial)
    if (!initial.worktreePath || !initial.branch || !initial.repositoryIdentity || !initial.baseSha) continue
    if (path.resolve(initial.worktreePath) !== path.join(expectedRoot, initial.runId)) continue
    if (!['checkpointing', 'cleaning', 'completed', 'failed', 'aborted', 'rejecting'].includes(initial.lifecycleState)) continue

    await manifestStore.withRun(initial.workflowId, initial.runId, async transaction => {
      let manifest = transaction.current()
      if (!manifest.worktreePath || !manifest.branch || !manifest.repositoryIdentity || !manifest.baseSha) return
      const worktreeExists = await fsp.access(manifest.worktreePath).then(() => true, () => false)

      if (manifest.lifecycleState === 'checkpointing') {
        if (!worktreeExists) return
        try {
          await checkpointWorktree(manifest.worktreePath, manifest.runId)
          const inspected = await inspectManagedWorktree(
            manifest.originalCwd,
            manifest.repositoryIdentity,
            manifest.worktreePath,
            manifest.branch,
          )
          if (!inspected.ok) {
            await transaction.transition(current => ({ ...current, lifecycleState: 'failed', completionStatus: 'error', disposition: 'unavailable', failureReason: inspected.message }))
            return
          }
          manifest = await transaction.transition(current => ({ ...current, lifecycleState: 'cleaning', resultSha: inspected.resultSha }))
        } catch (err) {
          await transaction.transition(current => ({
            ...current,
            lifecycleState: 'failed',
            completionStatus: 'error',
            disposition: 'unavailable',
            failureReason: `Orphan checkpoint failed; the worktree was retained: ${err instanceof Error ? err.message : String(err)}`,
          }))
          return
        }
      }

      if (!manifest.resultSha || !manifest.repositoryIdentity || !manifest.worktreePath || !manifest.branch) return
      const authority = resultAuthority(manifest)
      if (!authority) return

      if (manifest.lifecycleState === 'rejecting') {
        if (worktreeExists) {
          const removed = await removeVerifiedWorktree(
            manifest.originalCwd,
            manifest.repositoryIdentity,
            manifest.worktreePath,
            manifest.branch,
            manifest.resultSha,
          )
          if (!removed.ok) {
            await transaction.transition(current => ({ ...current, lifecycleState: 'paused', disposition: 'unavailable', failureReason: removed.message }))
            return
          }
        }
        const discarded = await discardResultBranch(authority)
        if (discarded.ok || discarded.code === 'branch_missing') {
          await transaction.transition(current => ({ ...current, lifecycleState: 'rejected', completionStatus: 'aborted', disposition: 'discarded', failureReason: 'Rejected by reviewer' }))
        } else {
          await transaction.transition(current => ({ ...current, lifecycleState: 'failed', completionStatus: 'error', disposition: 'ready', failureReason: discarded.message }))
        }
        return
      }

      if (manifest.lifecycleState === 'cleaning') {
        const status = manifest.completionStatus ?? 'error'
        const preserveResult = status === 'complete' || manifest.resultSha !== manifest.baseSha
        if (worktreeExists) {
          const removed = await removeVerifiedWorktree(
            manifest.originalCwd,
            manifest.repositoryIdentity,
            manifest.worktreePath,
            manifest.branch,
            manifest.resultSha,
          )
          if (!removed.ok) {
            await transaction.transition(current => ({ ...current, lifecycleState: 'failed', completionStatus: 'error', disposition: 'unavailable', failureReason: removed.message }))
            return
          }
        }
        if (preserveResult) {
          const verified = await verifyManagedResult(authority)
          if (!verified.ok) {
            await transaction.transition(current => ({ ...current, lifecycleState: 'failed', completionStatus: 'error', disposition: 'unavailable', failureReason: verified.message }))
            return
          }
        } else {
          const discarded = await discardResultBranch(authority)
          if (!discarded.ok && discarded.code !== 'branch_missing') {
            await transaction.transition(current => ({ ...current, lifecycleState: 'failed', completionStatus: 'error', disposition: 'ready', failureReason: discarded.message }))
            return
          }
        }
        await transaction.transition(current => {
          const next = {
            ...current,
            lifecycleState: status === 'complete' ? 'completed' as const : status === 'aborted' ? 'aborted' as const : 'failed' as const,
            disposition: preserveResult ? 'ready' as const : 'unavailable' as const,
          }
          if (!preserveResult) delete next.resultSha
          return next
        })
        return
      }

      if (worktreeExists) {
        const removed = await removeVerifiedWorktree(
          manifest.originalCwd,
          manifest.repositoryIdentity,
          manifest.worktreePath,
          manifest.branch,
          manifest.resultSha,
        )
        if (!removed.ok) return
      }
      if (manifest.disposition === 'unavailable') {
        // A prior cleanup verification failure may become recoverable after restart.
        const verified = await verifyManagedResult(authority)
        if (verified.ok) await transaction.transition(current => ({ ...current, disposition: 'ready', failureReason: undefined }))
      }
    }).catch(() => { /* malformed/racing authority is retained */ })
    const final = await manifestStore.read(initial.workflowId, initial.runId).catch(() => null)
    if (final) await cleanupTerminalBinding(final)
  }
}

/** Addendum 8 precedence. Also used by the approve (resume) path. */
export async function classifyAndFinish(args: FireOptions & {
  runId: string
  wt: WorktreeInfo | null
  result: WorkflowRunResult
  runtimeBinding?: RunSkillBinding
}): Promise<void> {
  const { store, runId, workflowId, workflowSlug, wt, result } = args
  const manifests = args.manifests ?? store.manifests
  const now = () => new Date().toISOString()
  const emit = (event: RunEvent) => store.append(event).catch(() => { /* teardown race */ })

  try {
    if (result.status === 'complete') {
      const events = await store.getEvents(workflowId, runId)
      const last = events?.[events.length - 1]
      if (last?.type === 'awaiting_approval') {
        await manifests.transition(workflowId, runId, manifest => ({
          ...manifest,
          lifecycleState: 'paused',
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          disposition: 'unavailable',
        }))
        if (result.sessionId) {
          await emit({
            runId,
            workflowId,
            workflowSlug,
            type: 'run_paused',
            ts: now(),
            sessionId: result.sessionId,
            source: 'test',
            ...(wt ? { worktreePath: wt.worktreePath } : {}),
          })
        }
        return
      }
    }

    if (wt) {
      await manifests.transition(workflowId, runId, manifest => ({
        ...manifest,
        lifecycleState: 'checkpointing',
        completionStatus: completionStatus(result.status),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        disposition: 'unavailable',
      }))
      try {
        await checkpointWorktree(wt.worktreePath, runId)
      } catch (err) {
        const message = `The run finished, but CWC could not preserve its work on the run branch. The worktree was retained at ${wt.worktreePath}. Resolve the Git error before removing it: ${err instanceof Error ? err.message : String(err)}`
        await transitionFailure(manifests, workflowId, runId, message)
        await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message, sessionId: result.sessionId })
        return
      }

      const manifest = await manifests.read(workflowId, runId)
      if (!manifest?.repositoryIdentity || !manifest.branch || !manifest.worktreePath) {
        const message = 'The run checkpointed, but its manifest no longer contains complete worktree authority. The worktree was retained for manual recovery.'
        await transitionFailure(manifests, workflowId, runId, message)
        await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message })
        return
      }
      const inspection = await inspectManagedWorktree(args.cwd, manifest.repositoryIdentity, manifest.worktreePath, manifest.branch)
      if (!inspection.ok) {
        await transitionFailure(manifests, workflowId, runId, inspection.message)
        await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message: inspection.message })
        return
      }
      await manifests.transition(workflowId, runId, current => ({ ...current, lifecycleState: 'cleaning', resultSha: inspection.resultSha }))
      const removed = await removeVerifiedWorktree(args.cwd, manifest.repositoryIdentity, manifest.worktreePath, manifest.branch, inspection.resultSha)
      if (!removed.ok) {
        await transitionFailure(manifests, workflowId, runId, removed.message)
        await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message: removed.message })
        return
      }

      const preserveResult = result.status === 'complete' || inspection.resultSha !== wt.baseSha
      if (!preserveResult) {
        const current = await manifests.read(workflowId, runId)
        const authority = current ? resultAuthority(current) : null
        if (authority) {
          const discarded = await discardResultBranch(authority)
          if (!discarded.ok) {
            await transitionFailure(manifests, workflowId, runId, discarded.message)
            await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message: discarded.message })
            return
          }
        }
      }
      await manifests.transition(workflowId, runId, current => {
        const next = {
          ...current,
          lifecycleState: terminalState(result.status),
          completionStatus: completionStatus(result.status),
          disposition: preserveResult ? 'ready' as const : 'unavailable' as const,
          failureReason: result.status === 'complete' ? undefined : result.message,
          actionError: null,
        }
        if (!preserveResult) delete next.resultSha
        return next
      })
    } else {
      await manifests.transition(workflowId, runId, manifest => ({
        ...manifest,
        lifecycleState: terminalState(result.status),
        completionStatus: completionStatus(result.status),
        disposition: 'unavailable',
        failureReason: result.status === 'complete' ? undefined : result.message,
        actionError: null,
      }))
    }

    if (result.status === 'complete') {
      await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'complete', source: 'test', message: result.message, costUsd: result.costUsd, sessionId: result.sessionId })
    } else {
      await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: result.status, source: 'test', message: result.message })
    }
  } catch (err) {
    const message = `CWC could not finish the managed run lifecycle safely: ${err instanceof Error ? err.message : String(err)}`
    await transitionFailure(manifests, workflowId, runId, message).catch(() => {})
    await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message })
  } finally {
    if (args.runtimeBinding) {
      try {
        const manifest = await manifests.read(workflowId, runId)
        if (!manifest || manifest.lifecycleState !== 'paused') await args.runtimeBinding.cleanup()
      } catch {
        // Unknown authority may still describe a paused run after restart. Keep
        // its private binding rather than deleting the only safe resume source.
      }
    }
    store.releaseRun(runId)
  }
}
