// tests/server/triggers-webhook.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { triggersRouter } from '../../src/server/api/triggers.js'
import { runsRouter } from '../../src/server/api/runs.js'
import { createAutomationState } from '../../src/server/automation-state.js'
import { createRunStore } from '../../src/server/run-store.js'
import { makeBin } from '../helpers/make-bin.js'
import type { CwcFile, CwcTrigger } from '../../src/schema.js'

const TOKEN = 'tok-1'
const WF_ID = 'wf-webhook'
const WF_NAME = 'webhook-flow'

let binDir: string
let echoBin: string   // echoes stdin back as a run_completed message (for payload assertions)

let workflowsDir: string
let skillsDir: string
let runsDir: string
let statePath: string
let wtRoot: string
let server: http.Server
let base: string
let sharedState: ReturnType<typeof createAutomationState>
let sharedStore: ReturnType<typeof createRunStore>

function makeTrigger(over: Partial<CwcTrigger> = {}): CwcTrigger {
  return {
    id: 'trig-wh-1', type: 'webhook', token: TOKEN,
    cwd: '', // set per test after we know the dir
    isolation: 'in-place', catchUp: true, maxRunsPerDay: 10, enabled: true,
    ...over,
  }
}

async function writeWorkflow(trigger: CwcTrigger, metaOverrides: Partial<CwcFile['meta']> = {}): Promise<void> {
  const now = new Date().toISOString()
  const cwc: CwcFile = {
    meta: { id: WF_ID, name: WF_NAME, description: '', version: 1, created: now, updated: now, triggers: [trigger], ...metaOverrides },
    nodes: [], edges: [],
  }
  await fs.writeFile(path.join(workflowsDir, `${WF_ID}.cwc`), JSON.stringify(cwc))
}

async function writeExportedSkill(slug = 'cwc-webhook-flow'): Promise<void> {
  const skillDir = path.join(skillsDir, slug)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${slug}\n<!-- cwc:workflow:${WF_ID} -->\n`, 'utf-8')
}

async function waitForStatus(runId: string, want: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const summaries = await (await fetch(`${base}/api/runs?workflowId=${WF_ID}`)).json() as Array<Record<string, unknown>>
    const run = summaries.find(r => r.runId === runId)
    if (run && run.status === want) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} never reached status ${want}`)
}

async function getEvents(runId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/runs/${runId}/events?workflowId=${WF_ID}`)
  return res.json() as Promise<Array<Record<string, unknown>>>
}

async function waitForEvent(runId: string, type: string, ms = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const event = (await getEvents(runId)).find(candidate => candidate.type === type)
    if (event) return event
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} never recorded event ${type}`)
}

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-whtrig-bin-'))
  // The echo bin reads stdin (the prompt), and emits a run_completed with the full prompt as message
  echoBin = await makeBin(binDir, 'claude-echo', `const fs = require('fs')
const stdin = fs.readFileSync(0, 'utf-8')
process.stdout.write(JSON.stringify({ type: 'result', result: stdin, session_id: 's-echo', total_cost_usd: 0.01 }))
`)
})
afterAll(async () => { await fs.rm(binDir, { recursive: true }) })

beforeEach(async () => {
  workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-whtrig-wf-'))
  skillsDir = path.join(workflowsDir, 'skills')
  await writeExportedSkill()
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-whtrig-runs-'))
  statePath = path.join(workflowsDir, 'automation-state.json')
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-whtrig-wt-'))

  sharedState = createAutomationState(statePath)
  sharedStore = createRunStore(runsDir)

  const app = express()
  app.use(express.json())
  // Mount the real runs router for waitForStatus / getEvents polling
  app.use('/api/runs', runsRouter({ store: sharedStore, claudeBinPath: echoBin, worktreesRoot: wtRoot, runsDirPath: runsDir, skillsDir }))
  app.use('/api/triggers', triggersRouter({
    workflowsDir,
    state: sharedState,
    store: sharedStore,
    worktreesRoot: wtRoot,
    skillsDir,
    claudeBinPath: echoBin,
    isWorkflowBusy: async () => false,
  }))
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server?.close()
  await fs.rm(workflowsDir, { recursive: true, maxRetries: 5, retryDelay: 200 })
  await fs.rm(runsDir, { recursive: true, maxRetries: 5, retryDelay: 200 })
  await fs.rm(wtRoot, { recursive: true, maxRetries: 5, retryDelay: 200 })
})

describe('POST /api/triggers/:token', () => {
  it('returns 404 for unknown token', async () => {
    const res = await fetch(`${base}/api/triggers/unknown-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
  })

  it('returns 423 for unarmed trigger', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    // NOT armed — sharedState has no arm record for this trigger
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(423)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toMatch(/not armed/i)
  })

  it('returns 423 when globally paused', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    await sharedState.arm(t)
    await sharedState.setPaused(true)
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(423)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toMatch(/paused/i)
  })

  it('returns 409 when workflow is busy', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    await sharedState.arm(t)
    // close current server and start one with busy = true
    server.close()
    const app2 = express()
    app2.use(express.json())
    app2.use('/api/triggers', triggersRouter({
      workflowsDir, state: sharedState,
      store: sharedStore, worktreesRoot: wtRoot, skillsDir,
      claudeBinPath: echoBin,
      isWorkflowBusy: async () => 'running' as const,
    }))
    await new Promise<void>(r => { server = app2.listen(0, r) })
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(409)
    // skip state should be recorded
    const skipReason = sharedState.getTriggerState(t.id).lastSkip?.reason
    expect(skipReason).toBe('running')
  })

  it('returns 409 and records a skip when the workflow skill is missing', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await fs.rm(path.join(skillsDir, 'cwc-webhook-flow'), { recursive: true, force: true })
    await writeWorkflow(t)
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })

    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toMatch(/skill not exported/)
    expect(sharedState.getTriggerState(t.id).lastSkip?.reason).toBe('skill not exported')
    expect(await sharedStore.listRuns(WF_ID)).toEqual([])
  })

  it('fires when the skill exists only project-scoped in the trigger cwd', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await fs.rm(path.join(skillsDir, 'cwc-webhook-flow'), { recursive: true, force: true })
    const projectSkillDir = path.join(workflowsDir, '.claude', 'skills', 'cwc-webhook-flow')
    await fs.mkdir(projectSkillDir, { recursive: true })
    await fs.writeFile(path.join(projectSkillDir, 'SKILL.md'), `# cwc-webhook-flow\n<!-- cwc:workflow:${WF_ID} -->\n`, 'utf-8')
    await writeWorkflow(t)
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })

    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    await waitForStatus(runId, 'complete')
  })

  it('uses persisted exportedWorkflowSlug after a workflow rename', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await fs.rm(path.join(skillsDir, 'cwc-webhook-flow'), { recursive: true, force: true })
    await writeExportedSkill('cwc-old-webhook-flow')
    await writeWorkflow(t, { name: 'Renamed Webhook Flow', exportedWorkflowSlug: 'cwc-old-webhook-flow' })
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    await waitForStatus(runId, 'complete')
    const completed = await waitForEvent(runId, 'run_completed')
    expect(completed.message).toMatch(/\/cwc-run-[0-9a-f]{16}:cwc-old-webhook-flow/)
    expect(completed.message).not.toContain('/cwc-renamed-webhook-flow')
  })

  it('runs a skill-tier artifact by its unprefixed slug', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeExportedSkill('webhook-flow')
    await writeWorkflow(t, { artifactKind: 'skill', artifactTier: 'loop' })
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    await waitForStatus(runId, 'complete')
    const completed = await waitForEvent(runId, 'run_completed')
    expect(completed.message).toMatch(/\/cwc-run-[0-9a-f]{16}:webhook-flow/)
    expect(completed.message).not.toContain('/cwc-webhook-flow')
  })

  it('returns 202 and fires for an armed token; prompt contains "Trigger payload:" with JSON body', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    await sharedState.arm(t)
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    expect(runId).toBeTruthy()
    await waitForStatus(runId, 'complete')
    const completed = await waitForEvent(runId, 'run_completed')
    // The echo bin emits the full prompt as the result message
    expect(completed.message).toContain('Trigger payload:')
    expect(completed.message).toContain('"hello"')
    expect(completed.message).toContain('"world"')
  })

  it('fans one webhook delivery out to every configured target', async () => {
    const targetA = path.join(workflowsDir, 'target-a')
    const targetB = path.join(workflowsDir, 'target-b')
    await fs.mkdir(targetA)
    await fs.mkdir(targetB)
    const t = makeTrigger({ cwd: targetA, targets: [targetB] })
    await writeWorkflow(t)
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(202)
    const body = await res.json() as { runId: string; runs: Array<{ cwd: string; runId: string }>; skipped: unknown[] }
    expect(body.runId).toBe(body.runs[0].runId)
    expect(body.runs.map(run => run.cwd)).toEqual([targetA, targetB])
    expect(new Set(body.runs.map(run => run.runId)).size).toBe(2)
    expect(body.skipped).toEqual([])
    await Promise.all(body.runs.map(run => waitForStatus(run.runId, 'complete')))
    const startedCwds = await Promise.all(body.runs.map(async run => (await getEvents(run.runId))[0].cwd))
    expect(startedCwds).toEqual([targetA, targetB])
  })

  it('reports a skipped target without hiding successful webhook fan-out runs', async () => {
    const gitTarget = path.join(workflowsDir, 'git-target')
    const invalidTarget = path.join(workflowsDir, 'not-a-repo')
    await fs.mkdir(gitTarget)
    await fs.mkdir(invalidTarget)
    execFileSync('git', ['-C', gitTarget, 'init', '-b', 'main'])
    execFileSync('git', ['-C', gitTarget, 'config', 'user.email', 't@t'])
    execFileSync('git', ['-C', gitTarget, 'config', 'user.name', 't'])
    await fs.writeFile(path.join(gitTarget, 'README.md'), 'base\n')
    execFileSync('git', ['-C', gitTarget, 'add', '-A'])
    execFileSync('git', ['-C', gitTarget, 'commit', '-m', 'init'])
    const t = makeTrigger({ cwd: gitTarget, targets: [invalidTarget], isolation: 'worktree' })
    await writeWorkflow(t)
    await sharedState.arm(t)

    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(202)
    const body = await res.json() as { runs: Array<{ cwd: string; runId: string }>; skipped: Array<{ cwd: string; reason: string }> }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].cwd).toBe(gitTarget)
    expect(body.skipped).toEqual([{ cwd: invalidTarget, reason: 'not a git repo' }])
    await waitForStatus(body.runs[0].runId, 'complete')
  })

  it('truncates payload > 8KB with marker', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    await sharedState.arm(t)
    // build a body that will serialize to > 8KB
    const bigBody: Record<string, string> = {}
    for (let i = 0; i < 500; i++) bigBody[`key${i}`] = 'x'.repeat(20)
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bigBody),
    })
    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    await waitForStatus(runId, 'complete')
    const completed = await waitForEvent(runId, 'run_completed')
    expect(completed.message).toContain('…[truncated]')
  })

  it('non-JSON body → no payload section in prompt', async () => {
    const t = makeTrigger({ cwd: workflowsDir })
    await writeWorkflow(t)
    await sharedState.arm(t)
    const res = await fetch(`${base}/api/triggers/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'just plain text',
    })
    expect(res.status).toBe(202)
    const { runId } = await res.json() as { runId: string }
    await waitForStatus(runId, 'complete')
    const completed = await waitForEvent(runId, 'run_completed')
    expect(completed.message).not.toContain('Trigger payload:')
  })
})
