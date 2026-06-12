// src/server/run-launcher.ts
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { RunStore } from './run-store.js'
import type { RunEvent } from '../run-events.js'
import { runWorkflowSkill, type WorkflowRunResult } from './workflow-runner.js'
import { isGitRepo, resolveBaseSha, createWorktree, removeWorktree, type WorktreeInfo } from './run-isolation.js'

export interface FireOptions {
  workflowId: string
  workflowSlug: string
  cwd: string
  isolation: 'worktree' | 'in-place'
  trigger: string                 // trigger id or 'manual'
  store: RunStore
  worktreesRoot: string
  baseRef?: string                // default 'HEAD'
  precondition?: string
  setupCommand?: string
  payload?: string                // webhook body, already truncated/formatted by caller
  runId?: string                  // test injection
  binPath?: string                // test injection
  env?: Record<string, string>    // test injection (passed to the child)
}

export type FireOutcome =
  | { fired: false; reason: string }
  | { fired: true; runId: string; settled: Promise<void> }

function sh(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      execFile('cmd', ['/d', '/s', '/c', command], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stderr?.toString() || stdout?.toString() || '').trim() })
      })
    } else {
      execFile('sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stderr?.toString() || stdout?.toString() || '').trim() })
      })
    }
  })
}

export async function fireWorkflow(opts: FireOptions): Promise<FireOutcome> {
  const now = () => new Date().toISOString()
  const runId = opts.runId ?? `run-${randomUUID().slice(0, 13)}`

  if (opts.precondition) {
    const pre = await sh(opts.precondition, opts.cwd, 60_000)
    if (!pre.ok) return { fired: false, reason: 'precondition' }
  }

  // Isolation + baseSha (baseSha recorded for ANY git cwd — Addendum 6)
  let wt: WorktreeInfo | null = null
  let baseSha: string | undefined
  const git = await isGitRepo(opts.cwd)
  if (opts.isolation === 'worktree') {
    if (!git) return { fired: false, reason: 'not a git repo' }
    try {
      wt = await createWorktree(opts.cwd, opts.workflowSlug, runId, opts.baseRef ?? 'HEAD', opts.worktreesRoot)
      baseSha = wt.baseSha
    } catch (err) {
      return { fired: false, reason: `worktree: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else if (git) {
    baseSha = await resolveBaseSha(opts.cwd, 'HEAD').catch(() => undefined)
  }
  const runCwd = wt?.worktreePath ?? opts.cwd

  const started: RunEvent = {
    runId, workflowId: opts.workflowId, workflowSlug: opts.workflowSlug,
    type: 'run_started', ts: now(), source: 'test', trigger: opts.trigger,
    cwd: opts.cwd, baseSha,
    ...(wt ? { worktreePath: wt.worktreePath, branch: wt.branch } : {}),
    message: opts.trigger === 'manual' ? 'Test run started from CWC' : `Fired by trigger ${opts.trigger}`,
  }

  const emit = (e: RunEvent) => opts.store.append(e).catch(() => { /* teardown race */ })

  if (opts.setupCommand) {
    const setup = await sh(opts.setupCommand, runCwd, 600_000)
    if (!setup.ok) {
      await emit(started)
      await emit({ runId, workflowId: opts.workflowId, workflowSlug: opts.workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message: `setupCommand failed: ${setup.output.slice(0, 2000)}` })
      if (wt) await removeWorktree(opts.cwd, wt.worktreePath, wt.branch, { keepBranch: false })
      return { fired: true, runId, settled: Promise.resolve() }
    }
  }

  await emit(started)
  const prompt = `/${opts.workflowSlug}\nUse run id ${runId} when logging run events.` + (opts.payload ? `\nTrigger payload:\n${opts.payload}` : '')
  const { stop, done } = runWorkflowSkill({ slug: opts.workflowSlug, runId, cwd: runCwd, binPath: opts.binPath, promptOverride: prompt, env: opts.env })
  opts.store.registerRun(runId, opts.workflowId, stop)

  const settled = done.then(result => classifyAndFinish({ ...opts, runId, wt, result }))
  return { fired: true, runId, settled }
}

/** Addendum 8 precedence. Also used by the approve (resume) path. */
export async function classifyAndFinish(args: FireOptions & { runId: string; wt: WorktreeInfo | null; result: WorkflowRunResult }): Promise<void> {
  const { store, runId, workflowId, workflowSlug, wt, result } = args
  store.releaseRun(runId)
  const now = () => new Date().toISOString()
  const emit = (e: RunEvent) => store.append(e).catch(() => { /* teardown race */ })

  if (result.status === 'complete') {
    const events = await store.getEvents(workflowId, runId)
    const last = events?.[events.length - 1]
    if (last?.type === 'awaiting_approval') {
      if (result.sessionId) {
        await emit({ runId, workflowId, workflowSlug, type: 'run_paused', ts: now(), sessionId: result.sessionId, source: 'test', ...(wt ? { worktreePath: wt.worktreePath } : {}) })
      }
      return   // paused either way; worktree intentionally kept
    }
    await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'complete', source: 'test', message: result.message, costUsd: result.costUsd, sessionId: result.sessionId })
  } else {
    await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: result.status, source: 'test', message: result.message })
  }
  if (wt) await removeWorktree(args.cwd, wt.worktreePath, wt.branch, { keepBranch: true })   // only reject deletes the branch
}
