import { it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runClaude, resolveClaudeBin } from '../../src/server/claude-runner.js'

let tmpDir: string
let fakeBin: string
let failBin: string
let garbageBin: string
let emptyBin: string
let errorBin: string
let stdinEchoBin: string

// Windows cannot spawn extension-less shebang scripts, so each fake binary is a
// Node script plus a .cmd shim there — which also exercises the runner's shell path.
async function makeBin(dir: string, name: string, source: string): Promise<string> {
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, `${name}.js`), source)
    const cmd = path.join(dir, `${name}.cmd`)
    await fs.writeFile(cmd, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`)
    return cmd
  }
  const bin = path.join(dir, name)
  await fs.writeFile(bin, `#!/usr/bin/env node\n${source}`, { mode: 0o755 })
  return bin
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-claude-bin-'))
  // Fake claude: echoes a JSON envelope; appends its argv to a log file.
  fakeBin = await makeBin(tmpDir, 'claude', `const fs = require('fs')
if (process.env.CLAUDE_ARGS_LOG) fs.appendFileSync(process.env.CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")
process.stdout.write(JSON.stringify({ type: 'result', result: 'HELLO BODY', session_id: 'sess-123' }))
`)

  failBin = await makeBin(tmpDir, 'claude-fail', `process.stderr.write('boom')
process.exit(1)
`)

  garbageBin = await makeBin(tmpDir, 'claude-garbage', `process.stdout.write('not json at all')
`)

  emptyBin = await makeBin(tmpDir, 'claude-empty', `process.stdout.write(JSON.stringify({ result: '' }))
`)

  errorBin = await makeBin(tmpDir, 'claude-iserror', `process.stdout.write(JSON.stringify({ result: 'I cannot do that', is_error: true, session_id: 'x' }))
`)

  // Echoes whatever arrives on stdin back as the result.
  stdinEchoBin = await makeBin(tmpDir, 'claude-stdin-echo', `const fs = require('fs')
if (process.env.CLAUDE_ARGS_LOG) fs.appendFileSync(process.env.CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")
const input = fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify({ type: 'result', result: input, session_id: 'sess-stdin' }))
`)
})

afterAll(async () => { await fs.rm(tmpDir, { recursive: true }) })

it('runs claude in print+json mode and returns result + sessionId', async () => {
  const logPath = path.join(tmpDir, 'args1.log')
  const out = await runClaude('my prompt', { binPath: fakeBin, env: { CLAUDE_ARGS_LOG: logPath } })
  expect(out.result).toBe('HELLO BODY')
  expect(out.sessionId).toBe('sess-123')
  const args = (await fs.readFile(logPath, 'utf-8')).trim()
  expect(args).toContain('-p')
  expect(args).toContain('--output-format')
  expect(args).toContain('json')
})

it('passes --resume when a sessionId is provided', async () => {
  const logPath = path.join(tmpDir, 'args2.log')
  await runClaude('next turn', { binPath: fakeBin, resume: 'sess-123', env: { CLAUDE_ARGS_LOG: logPath } })
  const args = (await fs.readFile(logPath, 'utf-8')).trim()
  expect(args).toContain('--resume')
  expect(args).toContain('sess-123')
})

it('throws when the binary path does not exist', async () => {
  await expect(runClaude('x', { binPath: '/no/such/claude' })).rejects.toThrow()
})

it('rejects with the stderr message when claude exits non-zero', async () => {
  await expect(runClaude('x', { binPath: failBin })).rejects.toThrow(/claude failed: boom/)
})

it('rejects when claude returns malformed JSON', async () => {
  await expect(runClaude('x', { binPath: garbageBin })).rejects.toThrow(/malformed JSON/)
})

it('rejects when claude returns an empty result', async () => {
  await expect(runClaude('x', { binPath: emptyBin })).rejects.toThrow(/empty result/)
})

it('rejects when claude returns is_error true', async () => {
  await expect(runClaude('x', { binPath: errorBin })).rejects.toThrow(/I cannot do that/)
})

it('delivers the prompt via stdin, never argv', async () => {
  const logPath = path.join(tmpDir, 'args3.log')
  const out = await runClaude('multi\nline prompt', { binPath: stdinEchoBin, timeoutMs: 5000, env: { CLAUDE_ARGS_LOG: logPath } })
  expect(out.result).toBe('multi\nline prompt')
  const args = (await fs.readFile(logPath, 'utf-8')).trim()
  expect(args).not.toContain('line prompt')
})

it('resolveClaudeBin finds Windows shims (claude.cmd / claude.exe) on win32', async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-win-bin-'))
  await fs.writeFile(path.join(binDir, 'claude.cmd'), '@echo off\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = binDir
  try {
    expect(resolveClaudeBin('win32')).toBe(path.join(binDir, 'claude.cmd'))
    // The extension-less name is not executable on Windows — must not match it.
    await fs.writeFile(path.join(binDir, 'claude'), '', { mode: 0o755 })
    expect(resolveClaudeBin('win32')).toBe(path.join(binDir, 'claude.cmd'))
  } finally {
    process.env.PATH = savedPath
    await fs.rm(binDir, { recursive: true })
  }
})

it('resolveClaudeBin finds a plain claude binary on posix', async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-posix-bin-'))
  await fs.writeFile(path.join(binDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = binDir
  try {
    expect(resolveClaudeBin('linux')).toBe(path.join(binDir, 'claude'))
  } finally {
    process.env.PATH = savedPath
    await fs.rm(binDir, { recursive: true })
  }
})
