// tests/server/run-launcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import { fireWorkflow, classifyAndFinish } from '../../src/server/run-launcher.js'
import { makeBin } from '../helpers/make-bin.js'

let binDir: string, okBin: string, gateBin: string, gateNoSessionBin: string
let runsDir: string, wtRoot: string, repo: string, store: RunStore

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-bin-'))
  okBin = await makeBin(binDir, 'claude', `const fs=require('fs');fs.readFileSync(0,'utf-8')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-ok', total_cost_usd:0.01 }))
`)
  // Gate fixtures read CWC_TEST_CFG (a JSON file the test writes: { jsonl, runId, workflowId })
  // and append an awaiting_approval line to the run JSONL — standing in for the orchestrator's curl.
  gateBin = await makeBin(binDir, 'claude-gate', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
const cfg = JSON.parse(fs.readFileSync(process.env.CWC_TEST_CFG, 'utf-8'))
fs.appendFileSync(cfg.jsonl, JSON.stringify({ runId: cfg.runId, workflowId: cfg.workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
process.stdout.write(JSON.stringify({ type:'result', result:'paused at gate', session_id:'s-gate' }))
`)
  gateNoSessionBin = await makeBin(binDir, 'claude-gate-nosess', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
const cfg = JSON.parse(fs.readFileSync(process.env.CWC_TEST_CFG, 'utf-8'))
fs.appendFileSync(cfg.jsonl, JSON.stringify({ runId: cfg.runId, workflowId: cfg.workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
process.stdout.write(JSON.stringify({ type:'result', result:'paused' }))
`)
})
afterAll(async () => { await fs.rm(binDir, { recursive: true }) })

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-runs-'))
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-wt-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-repo-'))
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  await fs.writeFile(path.join(repo, 'f.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'])
  store = createRunStore(runsDir)
})
afterEach(async () => {
  for (const d of [runsDir, wtRoot, repo]) await fs.rm(d, { recursive: true, maxRetries: 5, retryDelay: 100 })
})

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo,
    isolation: 'worktree' as const, trigger: 'manual', store,
    binPath: okBin, worktreesRoot: wtRoot, ...over,
  }
}

async function lastEvents(runId: string) {
  return (await store.getEvents('wf-1', runId))!
}

describe('fireWorkflow', () => {
  it('precondition non-zero → not fired, nothing recorded as a run', async () => {
    const r = await fireWorkflow(baseOpts({ precondition: 'exit 1' }))
    expect(r).toEqual({ fired: false, reason: 'precondition' })
    expect(await store.listRuns('wf-1')).toEqual([])
  })

  it('isolated happy path: worktree, baseSha on run_started, completion keeps branch, removes worktree', async () => {
    const r = await fireWorkflow(baseOpts())
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[0]).toMatchObject({ type: 'run_started', trigger: 'manual' })
    expect(events[0].branch).toBe(`cwc/cwc-x/${r.runId}`)
    expect(events[0].baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(events[events.length - 1]).toMatchObject({ type: 'run_completed', status: 'complete', sessionId: 's-ok' })
    // worktree gone, branch kept
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' })
    expect(branches).toContain(r.runId)
  })

  it('setupCommand failure → run exists with status error; worktree and branch removed', async () => {
    const r = await fireWorkflow(baseOpts({ setupCommand: 'exit 7' }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('error')
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' }).trim()
    expect(branches).toBe('')
  })

  it('gate exit with session → run_paused with sessionId + worktree KEPT', async () => {
    const runId = 'run-fixed-1'
    const cfgPath = path.join(runsDir, 'cwc-test-cfg.json')
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ jsonl: path.join(runsDir, 'wf-1', `${runId}.jsonl`), runId, workflowId: 'wf-1' }))
    const r = await fireWorkflow(baseOpts({ binPath: gateBin, runId, env: { CWC_TEST_CFG: cfgPath } }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const events = await lastEvents(r.runId)
    const last = events[events.length - 1]
    expect(last).toMatchObject({ type: 'run_paused', sessionId: 's-gate' })
    expect(last.worktreePath).toBe(path.join(wtRoot, r.runId))
    await expect(fs.access(path.join(wtRoot, r.runId))).resolves.toBeUndefined()
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('paused')
  })

  it('gate exit WITHOUT session → no run_paused emitted, summary still paused', async () => {
    const runId = 'run-fixed-2'
    const cfgPath = path.join(runsDir, 'cwc-test-cfg2.json')
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ jsonl: path.join(runsDir, 'wf-1', `${runId}.jsonl`), runId, workflowId: 'wf-1' }))
    const r = await fireWorkflow(baseOpts({ binPath: gateNoSessionBin, runId, env: { CWC_TEST_CFG: cfgPath } }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[events.length - 1].type).toBe('awaiting_approval')
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('paused')
  })

  it('in-place run in a git repo records baseSha but no worktreePath', async () => {
    const r = await fireWorkflow(baseOpts({ isolation: 'in-place' }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[0].baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(events[0].worktreePath).toBeUndefined()
  })
})
