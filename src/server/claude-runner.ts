import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface RunClaudeOptions {
  resume?: string
  binPath?: string
  timeoutMs?: number
  env?: Record<string, string>
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
  const isWinShim = /\.(cmd|bat)$/i.test(bin)
  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = execFile(
      isWinShim ? `"${bin}"` : bin,
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(opts.env ?? {}) },
        // .cmd/.bat cannot be spawned directly (Node rejects them with EINVAL);
        // args here are fixed tokens plus a session UUID, so shell mode is safe.
        shell: isWinShim,
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(new Error(`claude timed out after ${(opts.timeoutMs ?? 120_000) / 1000}s`))
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
    child.stdin?.end(prompt)
  })
}
