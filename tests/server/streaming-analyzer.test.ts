import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseStreamLine, runClaudeStreaming } from '../../src/server/streaming-analyzer.js'
import { makeBin } from '../helpers/make-bin.js'

describe('parseStreamLine', () => {
  it('maps system/init to an info log, ignores hook noise', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }))).toEqual({ kind: 'log', event: { level: 'info', message: expect.stringContaining('claude-sonnet-4-6') } })
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'hook_started' }))).toBeNull()
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'hook_response', output: 'HUGE' }))).toBeNull()
  })
  it('maps assistant text blocks to a claude log', () => {
    const r = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'scanning /repo' }] } }))
    expect(r).toEqual({ kind: 'log', event: { level: 'claude', message: 'scanning /repo' } })
  })
  it('maps result to a result with text + cost', () => {
    const r = parseStreamLine(JSON.stringify({ type: 'result', result: '{"automations":[]}', total_cost_usd: 0.02, is_error: false }))
    expect(r).toEqual({ kind: 'result', text: '{"automations":[]}', costUsd: 0.02, isError: false })
  })
  it('returns null on garbage and unknown types', () => {
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine(JSON.stringify({ type: 'whatever' }))).toBeNull()
    expect(parseStreamLine('')).toBeNull()
  })
  it('maps a rate_limit_event with utilization to an info log', () => {
    const r = parseStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.42, rateLimitType: 'tokens' } }))
    expect(r).toEqual({ kind: 'log', event: { level: 'info', message: expect.stringContaining('42%') } })
    // missing/!numeric utilization → ignored, never throws
    expect(parseStreamLine(JSON.stringify({ type: 'rate_limit_event' }))).toBeNull()
    expect(parseStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { utilization: 'high' } }))).toBeNull()
  })
  it('ignores assistant messages with no text (non-array or tool-only content)', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: 'oops' } }))).toBeNull()
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }))).toBeNull()
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
  })
  it('treats a result with a non-string result field as empty text, not a throw', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'result', result: { nested: true }, is_error: false }))).toEqual({ kind: 'result', text: '', costUsd: undefined, isError: false })
  })
  it('never throws on structurally weird but valid JSON', () => {
    expect(() => parseStreamLine(JSON.stringify([1, 2, 3]))).not.toThrow()
    expect(() => parseStreamLine('123')).not.toThrow()
    expect(() => parseStreamLine('null')).not.toThrow()
  })
})

describe('runClaudeStreaming', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-stream-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('streams log events and resolves the final result text', async () => {
    // fake claude prints stream-json lines then exits 0
    const source = `
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'clustering tasks' }] } }),
  JSON.stringify({ type: 'result', result: '{"automations":[]}', total_cost_usd: 0.01, is_error: false }),
]
process.stdout.write(lines.join('\\n') + '\\n')
process.exit(0)
`
    const bin = await makeBin(dir, 'claude', source)
    const logs: string[] = []
    const out = await runClaudeStreaming('prompt', { binPath: bin, onLog: e => logs.push(`${e.level}:${e.message}`) })
    expect(out.resultText).toBe('{"automations":[]}')
    expect(out.costUsd).toBe(0.01)
    expect(logs).toContain('claude:clustering tasks')
    expect(logs.some(l => l.startsWith('info:'))).toBe(true)
  })

  it('rejects when the result is an error', async () => {
    const source = `process.stdout.write(JSON.stringify({ type: 'result', result: 'boom', is_error: true }) + '\\n'); process.exit(0)`
    const bin = await makeBin(dir, 'claude', source)
    await expect(runClaudeStreaming('p', { binPath: bin, onLog: () => {} })).rejects.toThrow('boom')
  })

  it('captures the result even when the final line has no trailing newline', async () => {
    const source = `process.stdout.write(JSON.stringify({ type: 'result', result: '{"automations":[]}', total_cost_usd: 0.02, is_error: false })); process.exit(0)`
    const bin = await makeBin(dir, 'claude', source)
    const out = await runClaudeStreaming('p', { binPath: bin, onLog: () => {} })
    expect(out.resultText).toBe('{"automations":[]}')
  })

  it('rejects when the process exits 0 with no result at all', async () => {
    const bin = await makeBin(dir, 'claude', `process.exit(0)`)
    await expect(runClaudeStreaming('p', { binPath: bin, onLog: () => {} })).rejects.toThrow(/no result/i)
  })

  it('aborts a hanging process via the timeout and rejects', async () => {
    // never writes a result, just hangs — must be killed by the timeout
    const bin = await makeBin(dir, 'claude', `setInterval(() => {}, 1000)`)
    await expect(
      runClaudeStreaming('p', { binPath: bin, onLog: () => {}, timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/i)
  })

  it('ignores malformed lines interspersed with valid stream-json and still captures the result', async () => {
    const source = `
const lines = [
  'not json at all',
  '{ half a json object',
  'null',
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  JSON.stringify({ type: 'result', result: '{"automations":[]}', is_error: false }),
]
process.stdout.write(lines.join('\\n') + '\\n')
process.exit(0)
`
    const bin = await makeBin(dir, 'claude', source)
    const logs: string[] = []
    const out = await runClaudeStreaming('p', { binPath: bin, onLog: e => logs.push(e.message) })
    expect(out.resultText).toBe('{"automations":[]}')
    expect(logs).toContain('ok')
  })

  it('reassembles a result object split across multiple stdout chunks', async () => {
    const source = `
const obj = JSON.stringify({ type: 'result', result: '{"automations":[]}', total_cost_usd: 0.03, is_error: false })
const mid = Math.floor(obj.length / 2)
process.stdout.write(obj.slice(0, mid))
setTimeout(() => { process.stdout.write(obj.slice(mid) + '\\n'); process.exit(0) }, 40)
`
    const bin = await makeBin(dir, 'claude', source)
    const out = await runClaudeStreaming('p', { binPath: bin, onLog: () => {} })
    expect(out.resultText).toBe('{"automations":[]}')
    expect(out.costUsd).toBe(0.03)
  })

  it('rejects with stderr when the process exits non-zero with no result', async () => {
    const bin = await makeBin(dir, 'claude', `process.stderr.write('fatal: model unavailable'); process.exit(2)`)
    await expect(runClaudeStreaming('p', { binPath: bin, onLog: () => {} })).rejects.toThrow(/model unavailable/i)
  })
})
