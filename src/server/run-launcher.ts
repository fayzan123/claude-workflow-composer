// src/server/run-launcher.ts
import { exec, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { RunStore } from './run-store.js'
import type { RunEvent } from '../run-events.js'
import { runWorkflowSkill, type WorkflowRunResult } from './workflow-runner.js'
import { checkpointWorktree, isGitRepo, resolveBaseSha, createWorktree, removeWorktree, type WorktreeInfo } from './run-isolation.js'
import { killProcessTree } from './process-tree.js'

export interface FireOptions {
  workflowId: string
  workflowSlug: string
  cwd: string
  isolation: 'worktree' | 'in-place'
  trigger: string                 // trigger id or 'manual'
  store: RunStore
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

export async function fireWorkflow(opts: FireOptions): Promise<FireOutcome> {
  const now = () => new Date().toISOString()
  const runId = opts.runId ?? `run-${randomUUID().slice(0, 13)}`
  if (!opts.store.registerRun(runId, opts.workflowId, () => { /* launch placeholder */ }, opts.launchGroupId)) {
    return { fired: false, reason: 'workflow already active' }
  }
  const skip = (reason: string): FireOutcome => {
    opts.store.releaseRun(runId)
    return { fired: false, reason }
  }

  try {
    // The skill may live in the user scope OR the target project's .claude/skills —
    // project-scoped exports are first-class, and `claude` resolves them from the run cwd.
    if (opts.skillsDir) {
      const candidates = [
        path.join(opts.skillsDir, opts.workflowSlug, 'SKILL.md'),
        path.join(opts.cwd, '.claude', 'skills', opts.workflowSlug, 'SKILL.md'),
      ]
      const found = await Promise.all(candidates.map(p => fsp.access(p).then(() => true, () => false)))
      if (!found.includes(true)) return skip('skill not exported')
    }

    if (opts.precondition) {
      const pre = await runShellCommand(opts.precondition, opts.cwd, 60_000)
      if (!pre.ok) return skip('precondition')
    }

    // Isolation + baseSha (baseSha recorded for ANY git cwd — Addendum 6)
    let wt: WorktreeInfo | null = null
    let baseSha: string | undefined
    const git = await isGitRepo(opts.cwd)
    if (opts.isolation === 'worktree') {
      if (!git) return skip('not a git repo')
      try {
        wt = await createWorktree(opts.cwd, opts.workflowSlug, runId, opts.baseRef?.trim() || 'HEAD', opts.worktreesRoot)
        baseSha = wt.baseSha
      } catch (err) {
        return skip(`worktree: ${err instanceof Error ? err.message : String(err)}`)
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
      const setup = await runShellCommand(opts.setupCommand, runCwd, 600_000)
      if (!setup.ok) {
        await emit(started)
        let keepBranch = false
        if (wt) {
          try {
            keepBranch = await checkpointWorktree(wt.worktreePath, runId)
          } catch (err) {
            await emit({
              runId,
              workflowId: opts.workflowId,
              workflowSlug: opts.workflowSlug,
              type: 'run_completed',
              ts: now(),
              status: 'error',
              source: 'test',
              message: `The setup command failed, and CWC could not preserve its changes. The worktree was retained at ${wt.worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
            })
            opts.store.releaseRun(runId)
            return { fired: true, runId, settled: Promise.resolve() }
          }
        }
        await emit({ runId, workflowId: opts.workflowId, workflowSlug: opts.workflowSlug, type: 'run_completed', ts: now(), status: 'error', source: 'test', message: `setupCommand failed: ${setup.output.slice(0, 2000)}` })
        if (wt) await removeWorktree(opts.cwd, wt.worktreePath, wt.branch, { keepBranch })
        opts.store.releaseRun(runId)
        return { fired: true, runId, settled: Promise.resolve() }
      }
    }

    await emit(started)
    const prompt = `/${opts.workflowSlug}\nUse run id ${runId} when logging run events.` + (opts.payload ? `\nTrigger payload:\n${opts.payload}` : '')
    const { stop, done } = runWorkflowSkill({ slug: opts.workflowSlug, runId, cwd: runCwd, binPath: opts.binPath, promptOverride: prompt, env: opts.env })
    opts.store.registerRun(runId, opts.workflowId, stop)

    const settled = done.then(result => classifyAndFinish({ ...opts, runId, wt, result }))
    return { fired: true, runId, settled }
  } catch (err) {
    opts.store.releaseRun(runId)
    throw err
  }
}

/** On server start: remove worktrees whose runs are finished (or unknown); paused/running runs keep theirs. */
export async function sweepOrphanWorktrees(store: RunStore, runsDirPath: string, worktreesRoot: string): Promise<void> {
  let entries: string[] = []
  try { entries = await fsp.readdir(worktreesRoot) } catch { return }
  const live = new Set<string>()
  let wfs: string[] = []
  try { wfs = await fsp.readdir(runsDirPath) } catch { /* none */ }
  for (const wf of wfs) {
    for (const run of await store.listRuns(wf)) {
      if (run.status === 'paused' || run.status === 'running') live.add(run.runId)
    }
  }
  for (const runId of entries) {
    if (!runId.startsWith('run-')) continue   // only CWC-created run dirs — never delete other content under worktreesRoot
    if (live.has(runId)) continue
    const wtPath = path.join(worktreesRoot, runId)
    // Resolve the owning repo through verified worktree linkage before cleanup.
    await new Promise<void>(resolve => {
      execFile('git', ['-C', wtPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], (err, stdout) => {
        const finish = () => void fsp.rm(wtPath, { recursive: true, force: true }).catch(() => {}).then(() => resolve())
        // Without verified Git linkage there is nowhere safe to checkpoint the work.
        // Retain the directory for manual recovery instead of treating it as disposable.
        if (err) return resolve()
        const repo = path.dirname(stdout.toString().trim())   // <repo>/.git → <repo>
        void checkpointWorktree(wtPath, runId).then(() => {
          execFile('git', ['-C', repo, 'worktree', 'remove', '--force', wtPath], () => finish())
        }).catch(() => resolve())
      })
    })
  }
}

/** Addendum 8 precedence. Also used by the approve (resume) path. */
export async function classifyAndFinish(args: FireOptions & { runId: string; wt: WorktreeInfo | null; result: WorkflowRunResult }): Promise<void> {
  const { store, runId, workflowId, workflowSlug, wt, result } = args
  const now = () => new Date().toISOString()
  const emit = (e: RunEvent) => store.append(e).catch(() => { /* teardown race */ })

  try {
    if (result.status === 'complete') {
      const events = await store.getEvents(workflowId, runId)
      const last = events?.[events.length - 1]
      if (last?.type === 'awaiting_approval') {
        if (result.sessionId) {
          await emit({ runId, workflowId, workflowSlug, type: 'run_paused', ts: now(), sessionId: result.sessionId, source: 'test', ...(wt ? { worktreePath: wt.worktreePath } : {}) })
        }
        return   // paused either way; worktree intentionally kept
      }
    }

    if (wt) {
      try {
        await checkpointWorktree(wt.worktreePath, runId)
      } catch (err) {
        await emit({
          runId,
          workflowId,
          workflowSlug,
          type: 'run_completed',
          ts: now(),
          status: 'error',
          source: 'test',
          message: `The run finished, but CWC could not preserve its work on the run branch. The worktree was retained at ${wt.worktreePath}. Resolve the Git error before removing it: ${err instanceof Error ? err.message : String(err)}`,
          sessionId: result.sessionId,
        })
        return
      }
    }

    if (result.status === 'complete') {
      await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: 'complete', source: 'test', message: result.message, costUsd: result.costUsd, sessionId: result.sessionId })
    } else {
      await emit({ runId, workflowId, workflowSlug, type: 'run_completed', ts: now(), status: result.status, source: 'test', message: result.message })
    }
    if (wt) await removeWorktree(args.cwd, wt.worktreePath, wt.branch, { keepBranch: true })   // only reject deletes the branch
  } finally {
    store.releaseRun(runId)
  }
}
