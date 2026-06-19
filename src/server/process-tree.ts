import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Terminate a spawned child AND any of its descendants.
 *
 * On Windows every `claude` invocation goes through a cmd.exe shell shim (the npm `.cmd`
 * / native `.bat` launcher), so the real process is a *grandchild*. A plain `child.kill()`
 * only reaps the cmd.exe wrapper and orphans the grandchild — which keeps the inherited
 * stdout pipe open, so the parent's event loop never drains (and, under Vitest, the worker
 * "Failed to terminate", hanging CI forever). `taskkill /T` walks and tears down the whole
 * tree. POSIX spawns the binary directly with no shell wrapper, so a single SIGTERM to the
 * child is sufficient.
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
    child.kill('SIGTERM')
  }
}
