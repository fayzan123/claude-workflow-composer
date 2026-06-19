import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { killProcessTree } from './process-tree.js'

// Every runClaude caller is an LLM generation task (workflow promote, agent/skill build).
// In a heavily-loaded CLI environment these routinely take 60-90s and can spike past two
// minutes for larger outputs, so the default must be generous — 120s was mis-calibrated and
// surfaced as "claude timed out after 120s" on the longer promotions. Matches the scan ceiling.
const DEFAULT_TIMEOUT_MS = 300_000

export interface RunClaudeOptions {
  resume?: string
  binPath?: string
  timeoutMs?: number
  env?: Record<string, string>
  model?: string          // --model override (e.g. 'claude-sonnet-4-6'); omitted → CLI default
  signal?: AbortSignal
}

export interface RunClaudeResult {
  result: string
  sessionId: string
}

/** The injectable shape used by routers/tests. */
export type ClaudeRunner = (prompt: string, opts?: RunClaudeOptions) => Promise<RunClaudeResult>

/** Locate the `claude` binary: PATH first, then common install locations. */
export function resolveClaudeBin(platform: NodeJS.Platform = process.platform): string | null {
  // On Windows the npm shim is claude.cmd and the native installer ships claude.exe —
  // an extension-less `claude` file is not executable there.
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude']
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  const fallbackDirs = platform === 'win32'
    ? [path.join(os.homedir(), '.local', 'bin')]
    : [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    for (const name of names) {
      const p = path.join(dir, name)
      try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
    }
  }
  return null
}

export const runClaude: ClaudeRunner = (prompt, opts = {}) => {
  const bin = opts.binPath ?? resolveClaudeBin()
  if (!bin) {
    return Promise.reject(new Error('Claude Code CLI not found. Checked PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.'))
  }
  // The prompt goes over stdin, not argv: argv has hard length limits (8KB for
  // Windows .cmd shims, ARG_MAX elsewhere) and .cmd shims need a shell, where
  // user-authored argv content would be unsafe to interpolate.
  const args = ['-p', '--output-format', 'json']
  if (opts.resume) args.push('--resume', opts.resume)
  if (opts.model) args.push('--model', opts.model)
  const isWinShim = /\.(cmd|bat)$/i.test(bin)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<RunClaudeResult>((resolve, reject) => {
    // We manage timeout + cancellation ourselves (rather than execFile's `timeout`/`signal`
    // options) so the kill goes through killProcessTree: on Windows the binary runs behind a
    // cmd.exe shim, and execFile's own kill would orphan the real grandchild process — leaking
    // it and hanging the event loop. See process-tree.ts.
    let killReason: 'timeout' | 'abort' | null = null
    const child = execFile(
      isWinShim ? `"${bin}"` : bin,
      args,
      {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(opts.env ?? {}) },
        // .cmd/.bat cannot be spawned directly (Node rejects them with EINVAL);
        // args here are fixed tokens plus a session UUID, so shell mode is safe.
        shell: isWinShim,
      },
      (err, stdout, stderr) => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (err) {
          const abortErr = err as NodeJS.ErrnoException & { killed?: boolean; name?: string }
          if (killReason === 'abort' || opts.signal?.aborted || abortErr.name === 'AbortError' || abortErr.code === 'ABORT_ERR') {
            reject(new Error('claude cancelled.'))
            return
          }
          if (killReason === 'timeout' || abortErr.killed) {
            reject(new Error(`claude timed out after ${timeoutMs / 1000}s`))
            return
          }
          reject(new Error(`claude failed: ${stderr?.toString().trim() || err.message}`))
          return
        }
        let parsed: { result?: string; session_id?: string; is_error?: boolean }
        try {
          parsed = JSON.parse(stdout.toString())
        } catch {
          reject(new Error('claude returned malformed JSON output.'))
          return
        }
        if (typeof parsed.result !== 'string' || parsed.result.trim() === '') {
          reject(new Error('claude returned an empty result.'))
          return
        }
        if (parsed.is_error) {
          reject(new Error(parsed.result || 'claude returned an error result.'))
          return
        }
        resolve({ result: parsed.result, sessionId: parsed.session_id ?? '' })
      },
    )
    const timer = setTimeout(() => { killReason = 'timeout'; killProcessTree(child) }, timeoutMs)
    const onAbort = () => { killReason = 'abort'; killProcessTree(child) }
    if (opts.signal) {
      if (opts.signal.aborted) { killReason = 'abort'; killProcessTree(child) }
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdin?.end(prompt)
  })
}
