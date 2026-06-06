import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runClaude } from '../../src/server/claude-runner.js'

let tmpDir: string
let fakeBin: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-claude-bin-'))
  fakeBin = path.join(tmpDir, 'claude')
  // Fake claude: echoes a JSON envelope; appends its argv to a log file.
  const script = `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")
process.stdout.write(JSON.stringify({ type: 'result', result: 'HELLO BODY', session_id: 'sess-123' }))
`
  await fs.writeFile(fakeBin, script, { mode: 0o755 })
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
