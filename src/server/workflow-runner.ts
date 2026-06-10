// src/server/workflow-runner.ts
import { execFile, type ChildProcess } from 'node:child_process'
import { resolveClaudeBin } from './claude-runner.js'

export interface RunWorkflowOptions {
  slug: string          // workflow skill slug, e.g. cwc-my-pipeline
  runId: string
  cwd: string
  binPath?: string
  timeoutMs?: number    // default 30 min
}

export interface WorkflowRunResult {
  status: 'complete' | 'error' | 'aborted'
  message: string       // final result text or error description
  costUsd?: number
}

export interface RunningWorkflow {
  child: ChildProcess
  done: Promise<WorkflowRunResult>
}

/**
 * Spawns `claude -p` invoking the exported workflow skill. The prompt goes over
 * stdin (same rationale as claude-runner): the slash command plus the run id the
 * orchestrator should use for event logging.
 */
export function runWorkflowSkill(opts: RunWorkflowOptions): RunningWorkflow {
  const bin = opts.binPath ?? resolveClaudeBin()
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000
  if (!bin) {
    const child = null as unknown as ChildProcess
    return { child, done: Promise.resolve({ status: 'error', message: 'Claude Code CLI not found.' }) }
  }
  const isWinShim = /\.(cmd|bat)$/i.test(bin)
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']
  let settled = false
  let timedOut = false
  let resolveDone: (r: WorkflowRunResult) => void
  const done = new Promise<WorkflowRunResult>(res => { resolveDone = res })

  const child = execFile(
    isWinShim ? `"${bin}"` : bin,
    args,
    {
      cwd: opts.cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      shell: isWinShim,
    },
    (err, stdout, stderr) => {
      if (settled) return
      settled = true
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (timedOut) {
          resolveDone({ status: 'error', message: `Run timed out after ${Math.round(timeoutMs / 60_000)} minutes.` })
        } else if (e.killed || e.signal === 'SIGTERM') {
          resolveDone({ status: 'aborted', message: 'Run stopped.' })
        } else {
          resolveDone({ status: 'error', message: stderr?.toString().trim() || err.message })
        }
        return
      }
      try {
        const parsed = JSON.parse(stdout.toString()) as { result?: string; is_error?: boolean; total_cost_usd?: number }
        if (parsed.is_error) {
          resolveDone({ status: 'error', message: parsed.result || 'claude returned an error result.' })
        } else {
          resolveDone({ status: 'complete', message: parsed.result ?? '', costUsd: parsed.total_cost_usd })
        }
      } catch {
        resolveDone({ status: 'error', message: 'claude returned malformed JSON output.' })
      }
    },
  )
  // execFile's own timeout kills with SIGTERM, which we'd misreport as user-aborted —
  // track it so the timeout case wins.
  const timer = setTimeout(() => { timedOut = true }, timeoutMs - 50)
  child.on('exit', () => clearTimeout(timer))
  child.stdin?.end(`/${opts.slug}\nUse run id ${opts.runId} when logging run events.`)
  return { child, done }
}
