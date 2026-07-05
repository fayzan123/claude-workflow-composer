// tests/server/runs-test-run.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'
import { makeBin } from '../helpers/make-bin.js'

let binDir: string
let okBin: string
let hangBin: string
let runsDir: string
let cwd: string
let wtRoot: string
let homeDir: string
let server: http.Server
let base: string

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-testrun-bin-'))
  okBin = await makeBin(binDir, 'claude', `const fs = require('fs')
fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify({ type: 'result', result: 'workflow finished', session_id: 's', total_cost_usd: 0.05 }))
`)
  hangBin = await makeBin(binDir, 'claude-hang', `setTimeout(() => {}, 60000)
`)
})
afterAll(async () => { await fs.rm(binDir, { recursive: true }) })

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-testrun-runs-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-testrun-cwd-'))
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-testrun-wt-'))
  // Temp home with the exported skill so the /test export guard passes for slug 'cwc-flow'.
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-testrun-home-'))
  const skillDir = path.join(homeDir, '.claude', 'skills', 'cwc-flow')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# cwc-flow\n<!-- cwc:workflow:wf-1 -->\n')
})
afterEach(async () => {
  server?.close()
  await fs.rm(runsDir, { recursive: true, maxRetries: 5, retryDelay: 200 })
  await fs.rm(cwd, { recursive: true, maxRetries: 5, retryDelay: 200 })
  await fs.rm(wtRoot, { recursive: true, maxRetries: 5, retryDelay: 200 })
  await fs.rm(homeDir, { recursive: true, maxRetries: 5, retryDelay: 200 })
})

function startApp(binPath: string) {
  const app = createApp({
    staticDir: null, runsDir, claudeBinPath: binPath, worktreesRoot: wtRoot, userHomeDir: homeDir,
    automationStatePath: path.join(runsDir, 'astate.json'), configPath: path.join(runsDir, 'config.json'),
    enableNotifier: false,
  })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
}

function startBody() {
  return JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-flow', cwd })
}

async function waitForStatus(runId: string, want: string, ms = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const runs = (await (await fetch(`${base}/api/runs?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    const run = runs.find(r => r.runId === runId)
    if (run && run.status === want) return run
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} never reached status ${want}`)
}

describe('POST /api/runs/test', () => {
  it('spawns a run, emits ground-truth start and completion events', async () => {
    startApp(okBin)
    const res = await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startBody() })
    expect(res.status).toBe(200)
    const { runId } = (await res.json()) as { runId: string }
    const run = await waitForStatus(runId, 'complete')
    expect(run.source).toBe('test')
    const events = (await (await fetch(`${base}/api/runs/${runId}/events?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    expect(events[0]).toMatchObject({ type: 'run_started', source: 'test' })
    const last = events[events.length - 1] as Record<string, unknown>
    expect(last).toMatchObject({ type: 'run_completed', status: 'complete', costUsd: 0.05 })
    expect(last.message).toContain('workflow finished')
  })

  it('allows a run when the workflow skill exists only in the selected project', async () => {
    await fs.rm(path.join(homeDir, '.claude', 'skills', 'cwc-flow'), { recursive: true, force: true })
    const projectSkillDir = path.join(cwd, '.claude', 'skills', 'cwc-flow')
    await fs.mkdir(projectSkillDir, { recursive: true })
    await fs.writeFile(path.join(projectSkillDir, 'SKILL.md'), '# cwc-flow\n<!-- cwc:workflow:wf-1 -->\n', 'utf-8')

    startApp(okBin)
    const res = await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startBody() })

    expect(res.status).toBe(200)
    const { runId } = (await res.json()) as { runId: string }
    const run = await waitForStatus(runId, 'complete')
    expect(run.status).toBe('complete')
  })

  it('400 on missing fields or nonexistent cwd', async () => {
    startApp(okBin)
    expect((await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-flow', cwd: '/no/such/dir' }),
    })
    expect(res.status).toBe(400)
  })

  it('409 when a test run is already active for the workflow', async () => {
    startApp(hangBin)
    const first = await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startBody() })
    expect(first.status).toBe(200)
    const second = await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startBody() })
    expect(second.status).toBe(409)
    const { runId } = (await first.json()) as { runId: string }
    await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' })   // cleanup
    await waitForStatus(runId, 'aborted')
  })
})

describe('POST /api/runs/:runId/stop', () => {
  it('SIGTERMs the child and the run ends aborted', async () => {
    startApp(hangBin)
    const { runId } = (await (await fetch(`${base}/api/runs/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startBody() })).json()) as { runId: string }
    const res = await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' })
    expect(res.status).toBe(200)
    const run = await waitForStatus(runId, 'aborted')
    expect(run.source).toBe('test')
  })

  it('404 for unknown or finished runs', async () => {
    startApp(okBin)
    expect((await fetch(`${base}/api/runs/ghost/stop`, { method: 'POST' })).status).toBe(404)
  })
})
