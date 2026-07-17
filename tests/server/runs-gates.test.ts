// tests/server/runs-gates.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'
import { createRunStore } from '../../src/server/run-store.js'
import { getRepositoryIdentity } from '../../src/server/run-isolation.js'
import { makeBin } from '../helpers/make-bin.js'

let binDir: string
let okBin: string      // fast-completing bin (used for approve resume)
let slowBin: string    // slow-completing bin: keeps a resume "active" long enough to test double-approve

let runsDir: string, wtRoot: string, repo: string, homeDir: string
let server: http.Server
let base: string

// Gate bins are created per-beforeEach since they encode runsDir and workflowId.
let gateBin: string
let gateNoSessBin: string
let gateDiffBin: string
let gateSlowBin: string

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gates-bin-'))
  okBin = await makeBin(binDir, 'claude-ok', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
process.stdout.write(JSON.stringify({ type:'result', result:'workflow approved and complete', session_id:'s-resumed', total_cost_usd:0.02 }))
`)
  slowBin = await makeBin(binDir, 'claude-slow', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
setTimeout(() => process.stdout.write(JSON.stringify({ type:'result', result:'resumed slow', session_id:'s-done' })), 600)
`)
})
afterAll(async () => { await fs.rm(binDir, { recursive: true }) })

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gates-runs-'))
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gates-wt-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gates-repo-'))

  // Temp home with an exported skill so the /test export guard passes for slug 'cwc-x'.
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gates-home-'))
  const skillDir = path.join(homeDir, '.claude', 'skills', 'cwc-x')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# cwc-x\n<!-- cwc:workflow:wf-1 -->\n')
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  await fs.writeFile(path.join(repo, 'f.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'])

  // Create gate bins that use CWC_RUNS_DIR env var to find the run JSONL dynamically.
  // The bins read this env var at runtime to locate the run JSONL.
  const makeGate = async (name: string, withSession: boolean, commitChange = false, delayMs = 0) => {
    const commitBlock = commitChange ? `
const { execFileSync } = require('child_process')
const path2 = require('path')
const changeFile = path2.join(process.cwd(), 'gate-change.txt')
require('fs').writeFileSync(changeFile, 'changed by gate\\n')
execFileSync('git', ['-C', process.cwd(), 'add', '-A'])
execFileSync('git', ['-C', process.cwd(), 'commit', '-m', 'gate change'])
` : ''
    const resultObj = withSession
      ? `{ type:'result', result:'paused at gate', session_id:'s-gate' }`
      : `{ type:'result', result:'paused' }`
    const outputBlock = delayMs > 0
      ? `setTimeout(() => process.stdout.write(JSON.stringify(${resultObj})), ${delayMs})`
      : `process.stdout.write(JSON.stringify(${resultObj}))`
    // Reads CWC_RUNS_DIR (injected via process.env before server start) to scan for the latest JSONL.
    const src = `const fs=require('fs')
const path=require('path')
fs.readFileSync(0,'utf-8')
const runsDir = process.env.CWC_RUNS_DIR
const workflowId = process.env.CWC_WF_ID
const dir = path.join(runsDir, workflowId)
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
const jsonl = path.join(dir, files[files.length - 1])
const firstLine = JSON.parse(fs.readFileSync(jsonl, 'utf-8').trim().split('\\n')[0])
const runId = firstLine.runId
${commitBlock}
fs.appendFileSync(jsonl, JSON.stringify({ runId, workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
${outputBlock}
`
    return makeBin(binDir, name, src)
  }

  const suffix = Date.now().toString(36)
  gateBin = await makeGate(`gate-s-${suffix}`, true)
  gateNoSessBin = await makeGate(`gate-ns-${suffix}`, false)
  gateDiffBin = await makeGate(`gate-diff-${suffix}`, true, true)
  gateSlowBin = await makeGate(`gate-slow-${suffix}`, true, false, 700)
})
afterEach(async () => {
  server?.close()
  // Clean up env vars
  delete process.env.CWC_RUNS_DIR
  delete process.env.CWC_WF_ID
  for (const d of [runsDir, wtRoot, repo, homeDir]) {
    await fs.rm(d, { recursive: true, maxRetries: 5, retryDelay: 200 }).catch(() => { /* already gone */ })
  }
})

function startApp(binPath: string, runStore?: ReturnType<typeof createRunStore>) {
  // Set env so gate bins can find the run JSONL at runtime
  process.env.CWC_RUNS_DIR = runsDir
  process.env.CWC_WF_ID = 'wf-1'
  const app = createApp({
    staticDir: null, runsDir, claudeBinPath: binPath, worktreesRoot: wtRoot, userHomeDir: homeDir,
    automationStatePath: path.join(runsDir, 'astate.json'), configPath: path.join(runsDir, 'config.json'),
    enableNotifier: false, runStore,
  })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
}

async function waitForStatus(workflowId: string, runId: string, want: string, ms = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const runs = (await (await fetch(`${base}/api/runs?workflowId=${workflowId}`)).json()) as Record<string, unknown>[]
    const run = runs.find(r => r.runId === runId)
    if (run && run.status === want) return run
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`run ${runId} never reached status ${want}`)
}

async function waitForEvent(workflowId: string, runId: string, type: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/runs/${runId}/events?workflowId=${workflowId}`)
    if (res.status === 200) {
      const events = (await res.json()) as Record<string, unknown>[]
      if (events.some(e => e.type === type)) return
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`run ${runId} never emitted ${type}`)
}

describe('gate endpoints', () => {
  it('1. paused run appears in GET /api/runs/paused + GET /api/runs?workflowId', async () => {
    startApp(gateBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    expect(res.status).toBe(200)
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    // GET /api/runs/paused (global)
    const paused = (await (await fetch(`${base}/api/runs/paused`)).json()) as Record<string, unknown>[]
    const entry = paused.find(r => r.runId === runId)
    expect(entry).toBeDefined()
    expect(entry?.workflowId).toBe('wf-1')
    expect(entry?.status).toBe('paused')

    // GET /api/runs?workflowId
    const runs = (await (await fetch(`${base}/api/runs?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    const run = runs.find(r => r.runId === runId)
    expect(run).toMatchObject({
      status: 'paused',
      managed: true,
      disposition: 'unavailable',
      actions: { approve: true, reject: true, apply: false, discard: false },
    })
  })

  it('2. GET /api/runs/:runId/diff returns committed change from gate fixture', async () => {
    startApp(gateDiffBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    const diffRes = await fetch(`${base}/api/runs/${runId}/diff?workflowId=wf-1`)
    expect(diffRes.status).toBe(200)
    const diffBody = (await diffRes.json()) as Record<string, unknown>
    expect(diffBody.branch).toContain(runId)
    expect(diffBody.diff).toContain('gate-change.txt')
  })

  it('3. POST /approve resumes run; run ends complete; branch kept', async () => {
    startApp(gateBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')
    const manifestPath = path.join(runsDir, 'wf-1', `${runId}.manifest.json`)
    const pausedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as { runtimeBinding?: { id: string } }
    expect(pausedManifest.runtimeBinding?.id).toMatch(/^[0-9a-f]{16}$/)
    const bindingDir = path.join(wtRoot, '.skill-bindings', pausedManifest.runtimeBinding!.id)
    await fs.access(path.join(bindingDir, 'binding.json'))

    // The paused run is bound to its private plugin. A later deployment change
    // must not affect the resumed session after a server restart.
    await fs.writeFile(
      path.join(homeDir, '.claude', 'skills', 'cwc-x', 'SKILL.md'),
      '# replacement deployment\n<!-- cwc:workflow:wf-1 -->\n',
    )

    // Switch to okBin for the resume (approve spawns okBin which completes instantly)
    server.close()
    const app2 = createApp({
      staticDir: null, runsDir, claudeBinPath: okBin, worktreesRoot: wtRoot, userHomeDir: homeDir,
      automationStatePath: path.join(runsDir, 'astate.json'), configPath: path.join(runsDir, 'config.json'),
      enableNotifier: false,
    })
    server = app2.listen(0)
    base = `http://localhost:${(server.address() as AddressInfo).port}`

    const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', note: 'LGTM' }),
    })
    expect(approveRes.status).toBe(200)
    expect((await approveRes.json())).toMatchObject({ resumed: true })

    const completed = await waitForStatus('wf-1', runId, 'complete')
    expect(completed).toMatchObject({
      managed: true,
      disposition: 'ready',
      actions: { apply: true, discard: true, approve: false, reject: false },
    })

    // branch kept
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${runId}`], { encoding: 'utf-8' })
    expect(branches).toContain(runId)
    await expect(fs.access(bindingDir)).rejects.toThrow()
  })

  it('4a. Approve on a non-paused run → 409', async () => {
    startApp(okBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'complete')

    const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(approveRes.status).toBe(409)
    const body = (await approveRes.json()) as { error: string }
    expect(body.error).toContain('not paused')
  })

  it('4b. Approve on no-session paused run → 409 cannot resume', async () => {
    startApp(gateNoSessBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(approveRes.status).toBe(409)
    const body = (await approveRes.json()) as { error: string }
    expect(body.error).toContain('cannot resume')
  })

  it('4b2. Approve refuses a changed private binding and leaves the run paused', async () => {
    startApp(gateBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')
    const manifest = JSON.parse(
      await fs.readFile(path.join(runsDir, 'wf-1', `${runId}.manifest.json`), 'utf-8'),
    ) as { runtimeBinding: { id: string } }
    await fs.writeFile(
      path.join(wtRoot, '.skill-bindings', manifest.runtimeBinding.id, 'skills', 'cwc-x', 'SKILL.md'),
      'changed after pause',
    )

    const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(approveRes.status).toBe(409)
    expect(await approveRes.json()).toMatchObject({ code: 'runtime_binding_invalid' })
    const [summary] = (await (await fetch(`${base}/api/runs?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    expect(summary.lifecycleState).toBe('paused')
  })

  it('4c. Double-click Approve does not spawn a duplicate resume (second → 409)', async () => {
    startApp(gateBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    // Resume with a slow bin so the first approve stays active while the second arrives.
    server.close()
    const app2 = createApp({
      staticDir: null, runsDir, claudeBinPath: slowBin, worktreesRoot: wtRoot, userHomeDir: homeDir,
      automationStatePath: path.join(runsDir, 'astate.json'), configPath: path.join(runsDir, 'config.json'),
      enableNotifier: false,
    })
    server = app2.listen(0)
    base = `http://localhost:${(server.address() as AddressInfo).port}`

    const first = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(first.status).toBe(200)
    const resumedLog = await fetch(`${base}/api/runs/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId, workflowId: 'wf-1', workflowSlug: 'cwc-x', type: 'step_started',
        ts: new Date().toISOString(), message: 'resumed work is logging',
      }),
    })
    expect(resumedLog.status).toBe(200)
    const second = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toContain('still finishing')
  })

  it('4d. Approve/reject while awaiting_approval is still active returns 409', async () => {
    startApp(gateSlowBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    expect(res.status).toBe(200)
    const { runId } = (await res.json()) as { runId: string }
    await waitForEvent('wf-1', runId, 'awaiting_approval')

    const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(approveRes.status).toBe(409)
    expect(((await approveRes.json()) as { error: string }).error).toContain('still finishing')

    const rejectRes = await fetch(`${base}/api/runs/${runId}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(rejectRes.status).toBe(409)
    expect(((await rejectRes.json()) as { error: string }).error).toContain('still finishing')

    await waitForStatus('wf-1', runId, 'paused')
  })

  it('4e. Approve cannot resume while workflow deletion holds the workflow reservation', async () => {
    const runStore = createRunStore(runsDir)
    startApp(gateBin, runStore)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    expect(runStore.reserveWorkflow('wf-1', 'delete-in-progress')).toBe(true)
    try {
      const approveRes = await fetch(`${base}/api/runs/${runId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: 'wf-1' }),
      })
      expect(approveRes.status).toBe(409)
      expect(((await approveRes.json()) as { error: string }).error).toContain('reserved')
      expect(runStore.isActive(runId)).toBe(false)

      const events = await runStore.getEvents('wf-1', runId)
      expect(events?.some(event => event.message === 'Run resumed after approval')).toBe(false)
    } finally {
      runStore.releaseWorkflowReservation('wf-1', 'delete-in-progress')
    }
  })

  it('0. POST /test on an un-exported workflow → 400 (no silent no-op)', async () => {
    startApp(okBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-never-exported', cwd: repo }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('not exported')
  })

  it('5. POST /reject on paused run → aborted + worktree gone + branch deleted', async () => {
    startApp(gateBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')
    const pausedManifest = JSON.parse(
      await fs.readFile(path.join(runsDir, 'wf-1', `${runId}.manifest.json`), 'utf-8'),
    ) as { runtimeBinding: { id: string } }
    const bindingDir = path.join(wtRoot, '.skill-bindings', pausedManifest.runtimeBinding.id)
    await fs.access(bindingDir)

    const events = (await (await fetch(`${base}/api/runs/${runId}/events?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    const started = events.find(e => e.type === 'run_started') as Record<string, unknown>
    const worktreePath = started.worktreePath as string
    await fs.writeFile(path.join(worktreePath, 'pending-review.txt'), 'checkpoint before rejection\n')

    const rejectRes = await fetch(`${base}/api/runs/${runId}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', note: 'not ready' }),
    })
    expect(rejectRes.status).toBe(200)
    expect((await rejectRes.json())).toMatchObject({ rejected: true })
    await waitForStatus('wf-1', runId, 'aborted')
    const [rejectedSummary] = (await (await fetch(`${base}/api/runs?workflowId=wf-1`)).json()) as Record<string, unknown>[]
    expect(rejectedSummary).toMatchObject({
      managed: true,
      lifecycleState: 'rejected',
      disposition: 'discarded',
      actions: { diff: false, approve: false, reject: false, apply: false, discard: false },
    })
    const preservedSha = rejectedSummary.resultSha as string
    expect(execFileSync('git', ['-C', repo, 'show', `${preservedSha}:pending-review.txt`], { encoding: 'utf-8' })).toBe('checkpoint before rejection\n')

    // worktree gone
    await expect(fs.access(worktreePath)).rejects.toThrow()
    // branch deleted
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${runId}`], { encoding: 'utf-8' }).trim()
    expect(branches).toBe('')
    await expect(fs.access(bindingDir)).rejects.toThrow()
  })

  it('5b. POST /reject on no-session paused run also works', async () => {
    startApp(gateNoSessBin)
    const res = await fetch(`${base}/api/runs/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo }),
    })
    const { runId } = (await res.json()) as { runId: string }
    await waitForStatus('wf-1', runId, 'paused')

    const rejectRes = await fetch(`${base}/api/runs/${runId}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1', note: 'rejected no-session' }),
    })
    expect(rejectRes.status).toBe(200)
    await waitForStatus('wf-1', runId, 'aborted')
  })

  it('6. Reject/approve on unknown run → 404', async () => {
    startApp(okBin)
    const rejectRes = await fetch(`${base}/api/runs/ghost-run/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(rejectRes.status).toBe(404)

    const approveRes = await fetch(`${base}/api/runs/ghost-run/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(approveRes.status).toBe(404)
  })

  it('7. serves a diff for a completed worktree run from its kept branch', async () => {
    // Arrange: a real repo + a CWC run branch with a committed change, worktree removed.
    const diffRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-diff-repo-'))
    try {
      execFileSync('git', ['-C', diffRepo, 'init', '-b', 'main'])
      execFileSync('git', ['-C', diffRepo, 'config', 'user.email', 't@t.t'])
      execFileSync('git', ['-C', diffRepo, 'config', 'user.name', 't'])
      await fs.writeFile(path.join(diffRepo, 'a.txt'), 'one\n')
      execFileSync('git', ['-C', diffRepo, 'add', '-A'])
      execFileSync('git', ['-C', diffRepo, 'commit', '-m', 'init'])
      const baseSha = execFileSync('git', ['-C', diffRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      const branch = 'cwc/flow/run-done'
      execFileSync('git', ['-C', diffRepo, 'branch', branch])
      // Commit a change onto the branch without checking it out (keeps main clean).
      const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-diff-wt-')), 'w')
      execFileSync('git', ['-C', diffRepo, 'worktree', 'add', wt, branch])
      await fs.writeFile(path.join(wt, 'a.txt'), 'two\n')
      execFileSync('git', ['-C', wt, 'commit', '-am', 'change'])
      const resultSha = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      execFileSync('git', ['-C', diffRepo, 'worktree', 'remove', '--force', wt])

      // Pre-populate run events using a store pointed at runsDir (same dir the app uses).
      const store = createRunStore(runsDir)
      await store.append({ runId: 'run-done', workflowId: 'wf1', workflowSlug: 'flow', type: 'run_started', ts: new Date().toISOString(), source: 'test', cwd: diffRepo, baseSha, worktreePath: wt, branch })
      await store.append({ runId: 'run-done', workflowId: 'wf1', workflowSlug: 'flow', type: 'run_completed', ts: new Date().toISOString(), status: 'complete', source: 'test' })
      await store.manifests.create({
        runId: 'run-done', workflowId: 'wf1', workflowSkillSlug: 'flow', triggerId: 'manual',
        requestedIsolation: 'worktree', originalCwd: diffRepo, requestedBaseRef: 'HEAD',
      })
      const repositoryIdentity = await getRepositoryIdentity(diffRepo)
      await store.manifests.transition('wf1', 'run-done', manifest => ({
        ...manifest,
        lifecycleState: 'completed',
        completionStatus: 'complete',
        repositoryIdentity,
        baseSha,
        worktreePath: wt,
        branch,
        resultSha,
        disposition: 'ready',
      }))

      startApp(okBin)
      const res = await fetch(`${base}/api/runs/run-done/diff?workflowId=wf1`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.diff).toContain('+two')
      expect(body.branch).toBe(branch)
    } finally {
      await fs.rm(diffRepo, { recursive: true, force: true }).catch(() => { /* ignore */ })
    }
  })
})
