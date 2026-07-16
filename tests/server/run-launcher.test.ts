// tests/server/run-launcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import { fireWorkflow, classifyAndFinish, sweepOrphanWorktrees, runShellCommand } from '../../src/server/run-launcher.js'
import { createWorktree, getRepositoryIdentity, removeWorktree } from '../../src/server/run-isolation.js'
import { makeBin } from '../helpers/make-bin.js'

let binDir: string, okBin: string, dirtyBin: string, checkpointFailBin: string, gateBin: string, gateNoSessionBin: string
let runsDir: string, wtRoot: string, repo: string, store: RunStore

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-bin-'))
  okBin = await makeBin(binDir, 'claude', `const fs=require('fs');fs.readFileSync(0,'utf-8')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-ok', total_cost_usd:0.01 }))
`)
  dirtyBin = await makeBin(binDir, 'claude-dirty', `const fs=require('fs');fs.readFileSync(0,'utf-8')
fs.writeFileSync('f.txt', 'changed by run')
fs.writeFileSync('generated.txt', 'untracked run output')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-dirty' }))
`)
  checkpointFailBin = await makeBin(binDir, 'claude-checkpoint-fail', `const fs=require('fs');const cp=require('child_process');fs.readFileSync(0,'utf-8')
fs.writeFileSync('f.txt', 'cannot checkpoint this yet')
const lock = cp.execFileSync('git', ['rev-parse', '--git-path', 'index.lock'], { encoding: 'utf-8' }).trim()
fs.writeFileSync(lock, 'held by test')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-lock' }))
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
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('claims the workflow before asynchronous launch preparation begins', async () => {
    const precondition = path.join(runsDir, 'precondition.cjs')
    await fs.writeFile(precondition, 'setTimeout(() => process.exit(0), 100)\n')
    const firstPromise = fireWorkflow(baseOpts({
      runId: 'run-preparing',
      precondition: `"${process.execPath}" "${precondition}"`,
    }))

    const second = await fireWorkflow(baseOpts({ runId: 'run-overlap' }))
    expect(second).toEqual({ fired: false, reason: 'workflow already active' })
    expect(store.hasActiveTestRun('wf-1')).toBe(true)

    const first = await firstPromise
    if (first.fired !== true) return expect.fail('first run should fire')
    await first.settled
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('tree-kills a timed-out shell command and its descendants', async () => {
    // Script FILES, not nested `node -e` strings: inline scripts would need double-nested
    // quote escaping that cmd.exe + msvcrt argv parsing mangle on the Windows CI leg.
    const heartbeat = path.join(runsDir, 'shell-heartbeat.txt')
    const childPath = path.join(runsDir, 'shell-child.cjs')
    const parentPath = path.join(runsDir, 'shell-parent.cjs')
    await fs.writeFile(childPath, `const fs = require('fs')
const write = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()))
write()
setInterval(write, 50)
`)
    await fs.writeFile(parentPath, `const { spawn } = require('child_process')
spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(childPath)}], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`)
    // Generous timeout: slow CI runners can take >500ms just to spawn the node chain.
    const result = await runShellCommand(`"${process.execPath}" "${parentPath}"`, repo, 3000)

    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/timed out/)
    // Let the kill finish (250ms SIGKILL escalation / async taskkill), then assert the
    // grandchild's heartbeat has gone quiet.
    await new Promise(res => setTimeout(res, 600))
    const before = await fs.readFile(heartbeat, 'utf-8')
    await new Promise(res => setTimeout(res, 300))
    const after = await fs.readFile(heartbeat, 'utf-8')
    expect(after).toBe(before)
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
    const manifest = await store.manifests.read('wf-1', r.runId)
    expect(manifest).toMatchObject({
      lifecycleState: 'completed',
      completionStatus: 'complete',
      disposition: 'ready',
      branch: `cwc/cwc-x/${r.runId}`,
    })
    expect(manifest?.resultSha).toBe(execFileSync('git', ['-C', repo, 'rev-parse', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' }).trim())
  })

  it('snapshots uncommitted work onto the kept branch before removing an isolated worktree', async () => {
    const r = await fireWorkflow(baseOpts({ binPath: dirtyBin }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled

    const branch = `cwc/cwc-x/${r.runId}`
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:f.txt`], { encoding: 'utf-8' })).toBe('changed by run')
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:generated.txt`], { encoding: 'utf-8' })).toBe('untracked run output')
    expect(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s', branch], { encoding: 'utf-8' }).trim()).toContain(r.runId)
    expect((await store.manifests.read('wf-1', r.runId))?.disposition).toBe('ready')
  })

  it('retains a checkpoint-failed worktree and exposes no Apply or Discard authority', async () => {
    const r = await fireWorkflow(baseOpts({ binPath: checkpointFailBin }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled

    const manifest = await store.manifests.read('wf-1', r.runId)
    expect(manifest).toMatchObject({ lifecycleState: 'failed', completionStatus: 'error', disposition: 'unavailable' })
    expect(manifest?.resultSha).toBeUndefined()
    await expect(fs.readFile(path.join(wtRoot, r.runId, 'f.txt'), 'utf-8')).resolves.toBe('cannot checkpoint this yet')
    const [summary] = await store.listRuns('wf-1')
    expect(summary).toMatchObject({ status: 'error', actions: { apply: false, discard: false } })
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
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'failed', disposition: 'unavailable' })
  })

  it('checkpoints setup changes before cleaning up a failed isolated run', async () => {
    const setupScript = path.join(runsDir, 'setup-fail.cjs')
    await fs.writeFile(setupScript, "require('fs').writeFileSync('setup-output.txt', 'recoverable setup work')\nprocess.exit(7)\n")
    const r = await fireWorkflow(baseOpts({ setupCommand: `"${process.execPath}" "${setupScript}"` }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled

    const branch = `cwc/cwc-x/${r.runId}`
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:setup-output.txt`], { encoding: 'utf-8' })).toBe('recoverable setup work')
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    expect((await store.listRuns('wf-1'))[0].status).toBe('error')
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'failed', disposition: 'ready' })
    expect((await store.listRuns('wf-1'))[0]).toMatchObject({ actions: { apply: false, discard: true } })
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
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'paused', sessionId: 's-gate', disposition: 'unavailable' })
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
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'paused', disposition: 'unavailable' })
  })

  it('in-place run in a git repo records baseSha but no worktreePath', async () => {
    const r = await fireWorkflow(baseOpts({ isolation: 'in-place' }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[0].baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(events[0].worktreePath).toBeUndefined()
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'completed', requestedIsolation: 'in-place', disposition: 'unavailable' })
  })
})

describe('sweepOrphanWorktrees', () => {
  it('uses manifests to clean verified terminal worktrees and retains paused, legacy, or unverifiable directories', async () => {
    const repositoryIdentity = await getRepositoryIdentity(repo)
    const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()

    // A paused manifest keeps its worktree without consulting observational events.
    const pausedRunId = 'run-paused-sweep'
    const pausedWtPath = path.join(wtRoot, pausedRunId)
    await fs.mkdir(pausedWtPath, { recursive: true })
    await store.manifests.create({
      runId: pausedRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', pausedRunId, manifest => ({
      ...manifest, lifecycleState: 'paused', repositoryIdentity, baseSha,
      worktreePath: pausedWtPath, branch: `cwc/cwc-x/${pausedRunId}`,
    }))

    // A checkpointing manifest is restart-recoverable and becomes ready.
    const doneRunId = 'run-done-sweep'
    const doneWorktree = await createWorktree(repo, 'cwc-x', doneRunId, 'HEAD', wtRoot)
    const doneWtPath = doneWorktree.worktreePath
    await fs.writeFile(path.join(doneWtPath, 'recovered.txt'), 'restart-safe')
    await store.manifests.create({
      runId: doneRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', doneRunId, manifest => ({
      ...manifest, lifecycleState: 'checkpointing', completionStatus: 'complete', repositoryIdentity,
      baseSha: doneWorktree.baseSha, worktreePath: doneWtPath, branch: doneWorktree.branch,
    }))

    // A valid but event-only legacy worktree receives no cleanup authority.
    const legacyRunId = 'run-legacy-sweep'
    const legacyWorktree = await createWorktree(repo, 'legacy', legacyRunId, 'HEAD', wtRoot)
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(path.join(runsDir, 'wf-1', `${legacyRunId}.jsonl`), JSON.stringify({
      runId: legacyRunId, workflowId: 'wf-1', workflowSlug: 'legacy', type: 'run_completed',
      status: 'complete', source: 'test', ts: new Date().toISOString(),
    }) + '\n')

    // Unknown/damaged Git linkage is retained for manual recovery, even when no run
    // claims it as live.
    const damagedWtPath = path.join(wtRoot, 'run-damaged-sweep')
    await fs.mkdir(damagedWtPath, { recursive: true })
    await fs.writeFile(path.join(damagedWtPath, 'recover-me.txt'), 'work')

    await sweepOrphanWorktrees(store, runsDir, wtRoot)

    // paused run's worktree must survive
    await expect(fs.access(pausedWtPath)).resolves.toBeUndefined()
    // completed run's worktree must be removed
    await expect(fs.access(doneWtPath)).rejects.toThrow()
    const doneManifest = await store.manifests.read('wf-1', doneRunId)
    expect(doneManifest).toMatchObject({ lifecycleState: 'completed', disposition: 'ready' })
    expect(execFileSync('git', ['-C', repo, 'show', `${doneManifest?.branch}:recovered.txt`], { encoding: 'utf-8' })).toBe('restart-safe')
    // legacy event metadata cannot authorize cleanup
    await expect(fs.access(legacyWorktree.worktreePath)).resolves.toBeUndefined()
    await expect(fs.readFile(path.join(damagedWtPath, 'recover-me.txt'), 'utf-8')).resolves.toBe('work')
  })

  it('finishes cleaning or rejection after a restart removed the worktree but not the result branch', async () => {
    const repositoryIdentity = await getRepositoryIdentity(repo)

    const cleaningRunId = 'run-cleaning-restart'
    const cleaning = await createWorktree(repo, 'cwc-x', cleaningRunId, 'HEAD', wtRoot)
    await fs.writeFile(path.join(cleaning.worktreePath, 'cleaning.txt'), 'preserved')
    execFileSync('git', ['-C', cleaning.worktreePath, 'add', '-A'])
    execFileSync('git', ['-C', cleaning.worktreePath, 'commit', '-m', 'cleaning result'])
    const cleaningSha = execFileSync('git', ['-C', cleaning.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    await store.manifests.create({
      runId: cleaningRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', cleaningRunId, manifest => ({
      ...manifest, lifecycleState: 'cleaning', completionStatus: 'complete', repositoryIdentity,
      baseSha: cleaning.baseSha, worktreePath: cleaning.worktreePath, branch: cleaning.branch, resultSha: cleaningSha,
    }))
    await removeWorktree(repo, cleaning.worktreePath, cleaning.branch, { keepBranch: true })

    const rejectingRunId = 'run-rejecting-restart'
    const rejecting = await createWorktree(repo, 'cwc-x', rejectingRunId, 'HEAD', wtRoot)
    await fs.writeFile(path.join(rejecting.worktreePath, 'rejected.txt'), 'discard me')
    execFileSync('git', ['-C', rejecting.worktreePath, 'add', '-A'])
    execFileSync('git', ['-C', rejecting.worktreePath, 'commit', '-m', 'rejected result'])
    const rejectingSha = execFileSync('git', ['-C', rejecting.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    await store.manifests.create({
      runId: rejectingRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', rejectingRunId, manifest => ({
      ...manifest, lifecycleState: 'rejecting', repositoryIdentity,
      baseSha: rejecting.baseSha, worktreePath: rejecting.worktreePath, branch: rejecting.branch, resultSha: rejectingSha,
    }))
    await removeWorktree(repo, rejecting.worktreePath, rejecting.branch, { keepBranch: true })

    const restartedStore = createRunStore(runsDir)
    await sweepOrphanWorktrees(restartedStore, runsDir, wtRoot)

    expect(await restartedStore.manifests.read('wf-1', cleaningRunId)).toMatchObject({ lifecycleState: 'completed', disposition: 'ready', resultSha: cleaningSha })
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', cleaning.branch], { encoding: 'utf-8' })).toContain(cleaning.branch)
    expect(await restartedStore.manifests.read('wf-1', rejectingRunId)).toMatchObject({ lifecycleState: 'rejected', disposition: 'discarded', resultSha: rejectingSha })
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', rejecting.branch], { encoding: 'utf-8' }).trim()).toBe('')
  })
})
