import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

/**
 * Terminate a spawned child AND any of its descendants.
 *
 * On Windows every `claude` invocation goes through a cmd.exe shell shim (the npm `.cmd`
 * / native `.bat` launcher), so the real process is a *grandchild*. A plain `child.kill()`
 * only reaps the cmd.exe wrapper and orphans the grandchild — which keeps the inherited
 * stdout pipe open, so the parent's event loop never drains (and, under Vitest, the worker
 * "Failed to terminate", hanging CI forever). `taskkill /T` walks and tears down the whole
 * tree. POSIX callers may also run through a shell for preconditions/setup commands, so we
 * recursively signal descendants before killing the direct child.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      // If taskkill itself can't launch, fall back to killing just the wrapper.
      killer.on('error', () => { child.kill() })
    } catch {
      child.kill()
    }
  } else {
    killPosixDescendants(child.pid, 'SIGTERM')
    child.kill('SIGTERM')
    setTimeout(() => {
      // Skip the escalation once the child has exited: its PID may have been reaped
      // (and could in principle be reused), so re-walking it would be wrong.
      if (child.exitCode !== null || child.signalCode !== null) return
      killPosixDescendants(child.pid!, 'SIGKILL')
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 250).unref()
  }
}

function killPosixDescendants(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  let children: number[] = []
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .split(/\s+/)
      .filter(value => /^\d+$/.test(value))
      .map(value => Number(value))
      .filter(value => value > 0)
  } catch { /* no children or pgrep unavailable */ }
  for (const childPid of children) killPosixDescendants(childPid, signal)
  for (const childPid of children) {
    try { process.kill(childPid, signal) } catch { /* already gone */ }
  }
}
