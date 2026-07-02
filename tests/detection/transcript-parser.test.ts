import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSession, parseSessionDetailed, discoverTranscripts } from '../../src/detection/transcript-parser.js'

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

describe('parseSessionDetailed', () => {
  const user = (n: number, text: string) => line({ type: 'user', sessionId: 'S1', cwd: '/repo', timestamp: `2026-06-14T10:0${n}:00.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } })
  const bash = (n: number, command: string) => line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: `2026-06-14T10:0${n}:00.000Z`, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

  it('counts malformed JSON lines while still parsing the valid ones', async () => {
    const p = await writeSession('mixed.jsonl', [
      user(0, 'first task'),
      '{not json at all\n',
      bash(1, 'npm test'),
      'also-not-json\n',
      user(2, 'second task'),
    ])
    const { units, stats } = await parseSessionDetailed(p)
    expect(units).toHaveLength(2)
    expect(stats.units).toBe(2)
    expect(stats.jsonErrors).toBe(2)
    expect(stats.lines).toBe(5)
    expect(stats.bytes).toBeGreaterThan(0)
  })

  it('counts unrecognized entry types instead of losing them silently', async () => {
    const p = await writeSession('drift.jsonl', [
      line({ type: 'summary', summary: 'compacted' }),
      user(0, 'do the thing'),
      line({ type: 'x-future-type', payload: { deeply: 'unknown' } }),
      line({ type: 'x-future-type' }),
      bash(1, 'make build'),
      line({ sessionId: 'S1' }), // no type at all
    ])
    const { units, stats } = await parseSessionDetailed(p)
    expect(units).toHaveLength(1)
    expect(stats.typeCounts['summary']).toBe(1)
    expect(stats.typeCounts['x-future-type']).toBe(2)
    expect(stats.typeCounts['(none)']).toBe(1)
    expect(stats.typeCounts['user']).toBe(1)
    expect(stats.typeCounts['assistant']).toBe(1)
  })

  it('treats non-object JSON lines as json errors rather than crashing', async () => {
    const p = await writeSession('nonobj.jsonl', [
      'null\n',
      '"just a string"\n',
      '42\n',
      user(0, 'still works'),
    ])
    const { units, stats } = await parseSessionDetailed(p)
    expect(units).toHaveLength(1)
    expect(stats.jsonErrors).toBe(3)
  })

  it('records a read error for a missing file instead of throwing', async () => {
    const missing = path.join(dir, 'nope.jsonl')
    const { units, stats } = await parseSessionDetailed(missing, dir)
    expect(units).toEqual([])
    expect(stats.readError).toBeTruthy()
    expect(stats.readError).not.toContain(dir)
    expect(stats.file).toBe(path.join('~', 'nope.jsonl'))
  })

  it('redacts the transcript path with the provided home dir', async () => {
    const p = await writeSession('r.jsonl', [user(0, 'x')])
    const { stats } = await parseSessionDetailed(p, dir)
    expect(stats.file).toBe(path.join('~', 'r.jsonl'))
    expect(stats.file).not.toContain(dir)
  })

  it('parses a large transcript without error', async () => {
    const lines: string[] = []
    for (let i = 0; i < 50_000; i++) lines.push(i % 10 === 0 ? user(0, `task ${i}`) : bash(1, `echo ${i}`))
    const p = await writeSession('big.jsonl', lines)
    const { units, stats } = await parseSessionDetailed(p)
    expect(stats.lines).toBe(50_000)
    expect(units.length).toBe(5_000)
  })
})

describe('discoverTranscripts', () => {
  it('finds .jsonl files across project dirs and reports discovery stats', async () => {
    const projects = path.join(dir, '.claude', 'projects')
    await fs.mkdir(path.join(projects, 'proj-a'), { recursive: true })
    await fs.mkdir(path.join(projects, 'proj-b'), { recursive: true })
    await fs.writeFile(path.join(projects, 'proj-a', 'x.jsonl'), '')
    await fs.writeFile(path.join(projects, 'proj-a', 'y.txt'), '')
    await fs.writeFile(path.join(projects, 'proj-b', 'z.jsonl'), '')
    const { files, stats } = await discoverTranscripts(dir)
    expect(files.sort()).toEqual([
      path.join(projects, 'proj-a', 'x.jsonl'),
      path.join(projects, 'proj-b', 'z.jsonl'),
    ])
    expect(stats).toEqual({
      root: path.join('~', '.claude', 'projects'),
      rootExists: true,
      projectDirs: 2,
      unreadableDirs: 0,
      transcriptFiles: 2,
    })
  })

  it('distinguishes a missing projects root from an empty history', async () => {
    const { files, stats } = await discoverTranscripts(dir)
    expect(files).toEqual([])
    expect(stats.rootExists).toBe(false)
    expect(stats.transcriptFiles).toBe(0)
  })

  it('counts entries that cannot be read as directories without aborting discovery', async () => {
    const projects = path.join(dir, '.claude', 'projects')
    await fs.mkdir(path.join(projects, 'proj-a'), { recursive: true })
    await fs.writeFile(path.join(projects, 'proj-a', 'x.jsonl'), '')
    await fs.writeFile(path.join(projects, 'stray-file'), 'not a directory')
    const { files, stats } = await discoverTranscripts(dir)
    expect(files).toEqual([path.join(projects, 'proj-a', 'x.jsonl')])
    expect(stats.projectDirs).toBe(1)
    expect(stats.unreadableDirs).toBe(1)
  })
})
