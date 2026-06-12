// src/server/workflow-runner.ts
import { execFile, type ChildProcess } from 'node:child_process'
import { resolveClaudeBin } from './claude-runner.js'

export interface RunWorkflowOptions {
  slug: string          // workflow skill slug, e.g. cwc-my-pipeline
  runId: string
  cwd: string
  binPath?: string
  timeoutMs?: number    // default 30 min
  resume?: string          // session id → adds --resume <id>
  promptOverride?: string  // replaces the default "/<slug>\nUse run id ..." stdin prompt
}

export interface WorkflowRunResult {
  status: 'complete' | 'error' | 'aborted'
  message: string       // final result text or error description
  costUsd?: number
  sessionId?: string
}

export interface RunningWorkflow {
  child: ChildProcess
  stop: () => void
  done: Promise<WorkflowRunResult>
}

// On Windows the spawned process is a cmd.exe shim wrapping the real node process;
// killing only the shim leaves the workflow running (and its stdio pipes open, so
// execFile's callback never fires). Kill the whole tree there.
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { /* best effort */ })
  } else {
    child.kill('SIGTERM')
  }
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
    return { child, stop: () => {}, done: Promise.resolve({ status: 'error', message: 'Claude Code CLI not found.' }) }
  }
  const isWinShim = /\.(cmd|bat)$/i.test(bin)
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']
  if (opts.resume) args.push('--resume', opts.resume)
  let settled = false
  let timedOut = false
  let stopped = false
  let resolveDone: (r: WorkflowRunResult) => void
  const done = new Promise<WorkflowRunResult>(res => { resolveDone = res })

  // No execFile `timeout` option: its SIGTERM only hits the shim on Windows.
  // We own the timeout below and tree-kill instead.
  const child = execFile(
    isWinShim ? `"${bin}"` : bin,
    args,
    {
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: isWinShim,
    },
    (err, stdout, stderr) => {
      if (settled) return
      settled = true
      if (timedOut) {
        resolveDone({ status: 'error', message: `Run timed out after ${Math.round(timeoutMs / 60_000)} minutes.` })
        return
      }
      if (stopped) {
        resolveDone({ status: 'aborted', message: 'Run stopped.' })
        return
      }
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (e.killed || e.signal === 'SIGTERM') {
          resolveDone({ status: 'aborted', message: 'Run stopped.' })
        } else {
          resolveDone({ status: 'error', message: stderr?.toString().trim() || err.message })
        }
        return
      }
      try {
        const parsed = JSON.parse(stdout.toString()) as { result?: string; is_error?: boolean; total_cost_usd?: number; session_id?: string }
        if (parsed.is_error) {
          resolveDone({ status: 'error', message: parsed.result || 'claude returned an error result.' })
        } else {
          resolveDone({ status: 'complete', message: parsed.result ?? '', costUsd: parsed.total_cost_usd, sessionId: parsed.session_id })
        }
      } catch {
        resolveDone({ status: 'error', message: 'claude returned malformed JSON output.' })
      }
    },
  )
  const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
  child.on('exit', () => clearTimeout(timer))
  child.stdin?.end(opts.promptOverride ?? `/${opts.slug}\nUse run id ${opts.runId} when logging run events.`)
  const stop = () => { stopped = true; killTree(child) }
  return { child, stop, done }
}
