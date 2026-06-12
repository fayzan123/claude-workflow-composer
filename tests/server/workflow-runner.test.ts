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
let stdinEchoArgsBin: string

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
  stdinEchoArgsBin = await makeBin(tmpDir, 'claude-echo-args', `const fs = require('fs')
fs.appendFileSync(${JSON.stringify(path.join(tmpDir, 'resume-args.log'))}, JSON.stringify(process.argv.slice(2)) + "\\n")
const input = fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify({ type: 'result', result: input, session_id: 's2' }))
`)
})
// maxRetries: Windows briefly holds dir locks while a killed process tree winds down.
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 200 }) })

it('invokes the skill by slug with acceptEdits, passes runId, runs in cwd', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wf-cwd-'))
  const { done } = runWorkflowSkill({ slug: 'cwc-my-flow', runId: 'run-abc', cwd, binPath: okBin })
  const result = await done
  expect(result.status).toBe('complete')
  expect(result.message).toContain('/cwc-my-flow')
  expect(result.message).toContain('run-abc')
  // basename, not the full path: Windows reports the cwd in 8.3 short form
  expect(result.message).toContain(path.basename(cwd))
  expect(result.costUsd).toBe(0.42)
  await fs.rm(cwd, { recursive: true, maxRetries: 5, retryDelay: 200 })
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

it('stop() kills the process tree and the run reports aborted', async () => {
  const { stop, done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: hangBin })
  setTimeout(stop, 200)
  const result = await done
  expect(result.status).toBe('aborted')
})

it('an external SIGTERM (posix) also reports aborted', async () => {
  if (process.platform === 'win32') return // direct child.kill only hits the .cmd shim there; stop() is the API
  const { child, done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: hangBin })
  setTimeout(() => child.kill('SIGTERM'), 200)
  const result = await done
  expect(result.status).toBe('aborted')
})

it('captures session_id from the envelope', async () => {
  const { done } = runWorkflowSkill({ slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: okBin })
  expect((await done).sessionId).toBe('s1')   // okBin already emits session_id: 's1'
})

it('resume mode passes --resume and uses the override prompt verbatim', async () => {
  const logPath = path.join(tmpDir, 'resume-args.log')
  const { done } = runWorkflowSkill({
    slug: 'cwc-x', runId: 'r', cwd: tmpDir, binPath: stdinEchoArgsBin,
    resume: 'sess-42', promptOverride: 'Approved — continue the workflow from the gate.\nNote: skip the README',
  })
  const result = await done
  expect(result.message).toContain('Approved — continue')
  expect(result.message).toContain('skip the README')
  expect(result.message).not.toContain('/cwc-x')   // override replaces the slash command entirely
  const args = (await fs.readFile(logPath, 'utf-8')).trim()
  expect(args).toContain('--resume')
  expect(args).toContain('sess-42')
})
