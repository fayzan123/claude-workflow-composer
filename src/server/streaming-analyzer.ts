// src/server/streaming-analyzer.ts
import { spawn } from 'node:child_process'
import { resolveClaudeBin } from './claude-runner.js'

export interface StreamLogEvent { level: 'info' | 'claude' | 'error'; message: string }
export interface StreamingRunResult { resultText: string; costUsd?: number }
export type StreamingRunner = (
  prompt: string,
  opts: { onLog: (e: StreamLogEvent) => void; binPath?: string; timeoutMs?: number; model?: string },
) => Promise<StreamingRunResult>

type ParsedLine =
  | { kind: 'log'; event: StreamLogEvent }
  | { kind: 'result'; text: string; costUsd?: number; isError?: boolean }
  | null

/** Map ONE stream-json NDJSON line to a log/result, or null (ignored). Never throws. */
export function parseStreamLine(line: string): ParsedLine {
  const t = line.trim()
  if (!t) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(t) } catch { return null }
  switch (o['type']) {
    case 'system':
      if (o['subtype'] === 'init') return { kind: 'log', event: { level: 'info', message: `Claude session started (model ${o['model'] ?? '?'})` } }
      return null   // hook_started / hook_response carry huge injected-context blobs — drop
    case 'assistant': {
      const content = (o['message'] as { content?: unknown })?.content
      if (!Array.isArray(content)) return null
      const text = content.filter(b => (b as { type?: string })?.type === 'text').map(b => (b as { text?: string }).text ?? '').join(' ').trim()
      return text ? { kind: 'log', event: { level: 'claude', message: text.slice(0, 500) } } : null
    }
    case 'rate_limit_event': {
      const info = o['rate_limit_info'] as { utilization?: number; rateLimitType?: string } | undefined
      if (typeof info?.utilization === 'number') return { kind: 'log', event: { level: 'info', message: `rate limit ${Math.round(info.utilization * 100)}% (${info.rateLimitType ?? ''})` } }
      return null
    }
    case 'result':
      return { kind: 'result', text: typeof o['result'] === 'string' ? (o['result'] as string) : '', costUsd: o['total_cost_usd'] as number | undefined, isError: !!o['is_error'] }
    default:
      return null
  }
}

/** Spawn `claude` in stream-json mode, forward log events live, resolve the final result text. */
export const runClaudeStreaming: StreamingRunner = (prompt, opts) => {
  const bin = opts.binPath ?? resolveClaudeBin()
  if (!bin) return Promise.reject(new Error('Claude Code CLI not found.'))
  const model = opts.model ?? 'claude-sonnet-4-6'
  const isWinShim = /\.(cmd|bat)$/i.test(bin)
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model]
  return new Promise<StreamingRunResult>((resolve, reject) => {
    const child = spawn(isWinShim ? `"${bin}"` : bin, args, { shell: isWinShim, env: { ...process.env } })
    let buf = ''
    let resultText = ''
    let costUsd: number | undefined
    let errored: string | null = null
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Analysis timed out.')) }, opts.timeoutMs ?? 5 * 60_000)

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        const parsed = parseStreamLine(line)
        if (!parsed) continue
        if (parsed.kind === 'log') opts.onLog(parsed.event)
        else { resultText = parsed.text; costUsd = parsed.costUsd; if (parsed.isError) errored = parsed.text || 'analysis returned an error' }
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Flush any final line that lacked a trailing newline — the result line is the
      // critical one and we must not depend on the CLI always newline-terminating it.
      if (buf.trim()) {
        const parsed = parseStreamLine(buf)
        if (parsed?.kind === 'log') opts.onLog(parsed.event)
        else if (parsed?.kind === 'result') { resultText = parsed.text; costUsd = parsed.costUsd; if (parsed.isError) errored = parsed.text || 'analysis returned an error' }
        buf = ''
      }
      if (errored) return reject(new Error(errored))
      if (code !== 0 && !resultText) return reject(new Error(stderr.trim() || `claude exited with code ${code}`))
      if (!resultText) return reject(new Error('Analysis produced no result.'))
      resolve({ resultText, costUsd })
    })
    child.stdin.end(prompt)
  })
}
