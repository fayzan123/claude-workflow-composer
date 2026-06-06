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
export function resolveClaudeBin(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ]
  // PATH lookup
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, 'claude')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
  }
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
  }
  return null
}

export const runClaude: ClaudeRunner = (prompt, opts = {}) => {
  const bin = opts.binPath ?? resolveClaudeBin()
  if (!bin) {
    return Promise.reject(new Error('Claude Code CLI not found. Checked PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.'))
  }
  const args = ['-p', prompt, '--output-format', 'json']
  if (opts.resume) args.push('--resume', opts.resume)
  return new Promise<RunClaudeResult>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(opts.env ?? {}) },
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
        let parsed: { result?: string; session_id?: string }
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
        resolve({ result: parsed.result, sessionId: parsed.session_id ?? '' })
      },
    )
  })
}
