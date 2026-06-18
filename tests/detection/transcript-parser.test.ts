import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSession } from '../../src/detection/transcript-parser.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-tx-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

function line(o: unknown): string { return JSON.stringify(o) + '\n' }

async function writeSession(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, lines.join(''))
  return p
}

describe('parseSession', () => {
  it('segments a session into task units by user prompt, collecting tools + bash commands', async () => {
    const ts = (n: number) => `2026-06-14T10:0${n}:00.000Z`
    const p = await writeSession('s.jsonl', [
      line({ type: 'mode', sessionId: 'S1' }),
      // task 1: a user prompt, then assistant edits + bash
      line({ type: 'user', sessionId: 'S1', cwd: '/repo', gitBranch: 'main', timestamp: ts(0), promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] } }),
      line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] } }),
      line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      // a tool_result carrier (role user, isMeta) must NOT start a new unit
      line({ type: 'user', sessionId: 'S1', cwd: '/repo', timestamp: ts(2), isMeta: true, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }] } }),
      // task 2: a new real prompt
      line({ type: 'user', sessionId: 'S1', cwd: '/repo', gitBranch: 'main', timestamp: ts(4), promptId: 'p2', message: { role: 'user', content: [{ type: 'text', text: 'now write docs' }] } }),
      line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: ts(5), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'README.md' } }] } }),
    ])
    const units = await parseSession(p)
    expect(units).toHaveLength(2)
    expect(units[0].tools).toEqual(['Edit', 'Bash', 'Bash'])
    expect(units[0].commands).toEqual(['npm test', 'git push'])
    expect(units[0].cwd).toBe('/repo')
    expect(units[0].sessionId).toBe('S1')
    expect(units[1].tools).toEqual(['Write'])
    expect(units[1].commands).toEqual([])
  })

  it('returns [] for an unreadable or empty file', async () => {
    const p = await writeSession('empty.jsonl', [])
    expect(await parseSession(p)).toEqual([])
    expect(await parseSession(path.join(dir, 'nope.jsonl'))).toEqual([])
  })

  it('captures the user prompt text on each unit', async () => {
    const ts = (n: number) => `2026-06-14T10:0${n}:00.000Z`
    const p = await writeSession('pt.jsonl', [
      line({ type: 'user', sessionId: 'S2', cwd: '/repo', timestamp: ts(0), message: { role: 'user', content: [{ type: 'text', text: 'fix the tests' }] } }),
      line({ type: 'assistant', sessionId: 'S2', cwd: '/repo', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      line({ type: 'user', sessionId: 'S2', cwd: '/repo', timestamp: ts(2), message: { role: 'user', content: 'a plain string prompt' } }),
    ])
    const units = await parseSession(p)
    expect(units[0].promptText).toBe('fix the tests')
    expect(units[1].promptText).toBe('a plain string prompt')
  })
})
