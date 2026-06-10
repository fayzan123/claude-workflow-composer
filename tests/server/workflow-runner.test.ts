// tests/server/workflow-runner.test.ts
import { it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runWorkflowSkill } from '../../src/server/workflow-runner.js'
import { makeBin } from '../helpers/make-bin.js'

let tmpDir: string
let okBin: string
let failBin: string
let hangBin: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wf-runner-'))
  // Echoes prompt + cwd into the envelope so tests can assert both.
  okBin = await makeBin(tmpDir, 'claude', `const fs = require('fs')
const input = fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify({ type: 'result', result: 'DONE::' + input + '::' + process.cwd(), session_id: 's1', total_cost_usd: 0.42 }))
`)
  failBin = await makeBin(tmpDir, 'claude-fail', `process.stderr.write('kaboom')
process.exit(1)
`)
  hangBin = await makeBin(tmpDir, 'claude-hang', `setTimeout(() => {}, 60000)
`)
})
afterAll(async () => { await fs.rm(tmpDir, { recursive: true }) })

it('invokes the skill by slug with acceptEdits, passes runId, runs in cwd', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wf-cwd-'))
  const { done } = runWorkflowSkill({ slug: 'cwc-my-flow', runId: 'run-abc', cwd, binPath: okBin })
  const result = await done
  expect(result.status).toBe('complete')
  expect(result.message).toContain('/cwc-my-flow')
  expect(result.message).toContain('run-abc')
  expect(result.message).toContain(await fs.realpath(cwd))
  expect(result.costUsd).toBe(0.42)
  await fs.rm(cwd, { recursive: true })
})

it('maps non-zero exit to error with stderr', async () => {
  const { done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: failBin })
  const result = await done
  expect(result.status).toBe('error')
  expect(result.message).toContain('kaboom')
})

it('kills on timeout and reports error', async () => {
  const { done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: hangBin, timeoutMs: 1500 })
  const result = await done
  expect(result.status).toBe('error')
  expect(result.message).toMatch(/timed out/)
})

it('exposes the child so callers can SIGTERM it; killed run reports aborted', async () => {
  const { child, done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: hangBin })
  setTimeout(() => child.kill('SIGTERM'), 200)
  const result = await done
  expect(result.status).toBe('aborted')
})
