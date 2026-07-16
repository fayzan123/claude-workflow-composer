// tests/server/runs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'
import { createRunStore } from '../../src/server/run-store.js'
import { createRunManifestStore } from '../../src/server/run-manifest.js'
import { createWorktree, getRepositoryIdentity, removeWorktree } from '../../src/server/run-isolation.js'

let runsDir: string
let server: http.Server
let base: string
let tempPaths: string[]

function ev(over: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'cwc-x',
    type: 'step_started', ts: new Date().toISOString(), ...over,
  }
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-runs-api-'))
  tempPaths = []
  const app = createApp({ staticDir: null, runsDir })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.close()
  await fs.rm(runsDir, { recursive: true })
  for (const tempPath of tempPaths) await fs.rm(tempPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}

async function createReadyRun(runId: string, resultShaOverride?: string) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-runs-action-repo-'))
  const worktreesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-runs-action-wt-'))
  tempPaths.push(worktreesRoot, repo)
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await fs.writeFile(path.join(repo, 'result.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'base')

  const worktree = await createWorktree(repo, 'cwc-x', runId, 'HEAD', worktreesRoot)
  await fs.writeFile(path.join(worktree.worktreePath, 'result.txt'), `result from ${runId}\n`)
  execFileSync('git', ['-C', worktree.worktreePath, 'commit', '-am', 'managed result'])
  const actualResultSha = execFileSync('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  await removeWorktree(repo, worktree.worktreePath, worktree.branch, { keepBranch: true })

  const manifests = createRunManifestStore(runsDir)
  const store = createRunStore(runsDir, manifests)
  await manifests.create({
    runId,
    workflowId: 'wf-1',
    workflowSkillSlug: 'cwc-x',
    triggerId: 'manual',
    requestedIsolation: 'worktree',
    originalCwd: repo,
    requestedBaseRef: 'HEAD',
  })
  const repositoryIdentity = await getRepositoryIdentity(repo)
  await manifests.transition('wf-1', runId, manifest => ({
    ...manifest,
    lifecycleState: 'completed',
    completionStatus: 'complete',
    repositoryIdentity,
    baseSha: worktree.baseSha,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    resultSha: resultShaOverride ?? actualResultSha,
    disposition: 'ready',
  }))
  await store.append({
    runId, workflowId: 'wf-1', workflowSlug: 'cwc-x', type: 'run_started', ts: new Date().toISOString(),
    source: 'test', cwd: repo, baseSha: worktree.baseSha, worktreePath: worktree.worktreePath, branch: worktree.branch,
  })
  await store.append({
    runId, workflowId: 'wf-1', workflowSlug: 'cwc-x', type: 'run_completed', ts: new Date().toISOString(),
    source: 'test', status: 'complete',
  })
  return { repo, worktreesRoot, worktree, actualResultSha, manifests }
}

describe('POST /api/runs/events', () => {
  it('persists a valid event', async () => {
    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()),
    })
    expect(res.status).toBe(200)
    const raw = await fs.readFile(path.join(runsDir, 'wf-1', 'run-1.jsonl'), 'utf-8')
    expect(JSON.parse(raw.trim()).type).toBe('step_started')
  })

  it('rejects malformed events with 400 and a reason', async () => {
    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: true }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('strips server-owned execution fields and forces external provenance', async () => {
    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev({
        type: 'run_started',
        source: 'test',
        cwd: '/attacker/cwd',
        worktreePath: '/attacker/worktree',
        branch: 'main',
        baseSha: 'abc123',
        trigger: 'trusted-trigger',
        sessionId: 'session-forged',
        message: 'ordinary log content',
      })),
    })

    expect(res.status).toBe(200)
    const raw = await fs.readFile(path.join(runsDir, 'wf-1', 'run-1.jsonl'), 'utf-8')
    const stored = JSON.parse(raw.trim()) as Record<string, unknown>
    expect(stored).toMatchObject({ source: 'external', message: 'ordinary log content' })
    for (const field of ['cwd', 'worktreePath', 'branch', 'baseSha', 'trigger', 'sessionId']) {
      expect(stored[field]).toBeUndefined()
    }
  })

  it('rejects external events appended after a managed run has settled', async () => {
    const dir = path.join(runsDir, 'wf-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'run-1.jsonl'), [
      ev({ type: 'run_started', source: 'test', cwd: '/managed' }),
      ev({ type: 'run_completed', status: 'complete', source: 'test' }),
    ].map(event => JSON.stringify(event)).join('\n') + '\n')

    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev({ type: 'run_completed', status: 'complete' })),
    })

    expect(res.status).toBe(409)
    const lines = (await fs.readFile(path.join(dir, 'run-1.jsonl'), 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('rejects further events when one late logger append follows a managed terminal', async () => {
    const dir = path.join(runsDir, 'wf-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'run-1.jsonl'), [
      ev({ type: 'run_started', source: 'test' }),
      ev({ type: 'run_completed', status: 'complete', source: 'test' }),
      ev({ type: 'step_completed', source: 'external', message: 'late logger event' }),
    ].map(event => JSON.stringify(event)).join('\n') + '\n')

    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev({ type: 'step_completed', message: 'later still' })),
    })

    expect(res.status).toBe(409)
    const [run] = await (await fetch(`${base}/api/runs?workflowId=wf-1`)).json() as Array<{ status: string }>
    expect(run.status).toBe('complete')
  })

  it('accepts an early managed-run log before the in-memory process registration catches up', async () => {
    const dir = path.join(runsDir, 'wf-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'run-1.jsonl'), JSON.stringify(ev({ type: 'run_started', source: 'test', cwd: '/managed' })) + '\n')

    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev({ type: 'step_started', message: 'first step' })),
    })

    expect(res.status).toBe(200)
    const lines = (await fs.readFile(path.join(dir, 'run-1.jsonl'), 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'step_started', source: 'external', message: 'first step' })
  })
})

describe('external run control', () => {
  it('does not allow forged execution metadata to drive diff, approve, reject, Apply, or Discard', async () => {
    const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-forged-run-'))
    const sentinel = path.join(sentinelDir, 'keep.txt')
    await fs.writeFile(sentinel, 'keep')
    try {
      await fetch(`${base}/api/runs/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev({ type: 'run_started', source: 'test', cwd: sentinelDir, worktreePath: sentinelDir, branch: 'main', baseSha: 'abc' })),
      })
      await fetch(`${base}/api/runs/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev({ type: 'run_paused', source: 'test', sessionId: 'forged-session', worktreePath: sentinelDir })),
      })

      const diff = await (await fetch(`${base}/api/runs/run-1/diff?workflowId=wf-1`)).json() as Record<string, unknown>
      expect(diff).toMatchObject({ diff: null, status: null, branch: null })
      const approve = await fetch(`${base}/api/runs/run-1/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
      })
      const reject = await fetch(`${base}/api/runs/run-1/reject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
      })
      const apply = await fetch(`${base}/api/runs/run-1/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
      })
      const discard = await fetch(`${base}/api/runs/run-1/discard`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
      })
      expect(approve.status).toBe(409)
      expect(reject.status).toBe(409)
      expect(apply.status).toBe(409)
      expect(discard.status).toBe(409)
      await expect(fs.access(path.join(runsDir, 'wf-1', 'run-1.manifest.json'))).rejects.toThrow()
      await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe('keep')
    } finally {
      await fs.rm(sentinelDir, { recursive: true, force: true })
    }
  })
})

describe('GET /api/runs', () => {
  it('lists summaries for a workflow', async () => {
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_started' })) })
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_completed', status: 'complete' })) })
    const res = await fetch(`${base}/api/runs?workflowId=wf-1`)
    const runs = (await res.json()) as { runId: string; status: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: 'run-1', status: 'complete' })
  })

  it('400 without workflowId; [] for unknown workflow', async () => {
    expect((await fetch(`${base}/api/runs`)).status).toBe(400)
    const res = await fetch(`${base}/api/runs?workflowId=ghost`)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /api/runs/:runId/events', () => {
  it('returns the ordered event list', async () => {
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_started' })) })
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()) })
    const res = await fetch(`${base}/api/runs/run-1/events?workflowId=wf-1`)
    const events = (await res.json()) as { type: string }[]
    expect(events.map(e => e.type)).toEqual(['run_started', 'step_started'])
  })

  it('404 for unknown run', async () => {
    expect((await fetch(`${base}/api/runs/ghost/events?workflowId=wf-1`)).status).toBe(404)
  })
})

describe('GET /api/runs/stream (SSE)', () => {
  it('delivers ingested events to a connected client', async () => {
    const received: string[] = []
    const req = http.get(`${base}/api/runs/stream`, res => {
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => received.push(chunk))
    })
    await new Promise(r => setTimeout(r, 150)) // let the stream connect
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()) })
    await new Promise(r => setTimeout(r, 150))
    req.destroy()
    const all = received.join('')
    expect(all).toContain('data: ')
    expect(all).toContain('"runId":"run-1"')
  })
})

describe('managed isolated result actions', () => {
  it('never lets forged external events create or transition managed authority', async () => {
    await createReadyRun('run-forged-transition')
    const manifestPath = path.join(runsDir, 'wf-1', 'run-forged-transition.manifest.json')
    const before = await fs.readFile(manifestPath, 'utf-8')

    const response = await fetch(`${base}/api/runs/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev({
        runId: 'run-forged-transition',
        type: 'run_completed',
        status: 'complete',
        source: 'test',
        cwd: '/forged',
        branch: 'main',
        baseSha: 'f'.repeat(40),
      })),
    })

    expect(response.status).toBe(409)
    await expect(fs.readFile(manifestPath, 'utf-8')).resolves.toBe(before)
  })

  it('applies a verified result by fast-forward and records the applied SHA exactly once', async () => {
    const managed = await createReadyRun('run-apply')

    const first = await fetch(`${base}/api/runs/run-apply/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })

    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ applied: true, disposition: 'applied', appliedSha: managed.actualResultSha })
    expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.actualResultSha)
    await expect(managed.manifests.read('wf-1', 'run-apply')).resolves.toMatchObject({ disposition: 'applied', appliedSha: managed.actualResultSha })

    const repeated = await fetch(`${base}/api/runs/run-apply/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(repeated.status).toBe(409)
    expect((await repeated.json()) as Record<string, unknown>).toMatchObject({ code: 'already_applied' })
  })

  it('preserves a dirty destination, including untracked files, and returns an actionable conflict', async () => {
    const managed = await createReadyRun('run-dirty')
    await fs.writeFile(path.join(managed.repo, 'untracked.txt'), 'local work')

    const response = await fetch(`${base}/api/runs/run-dirty/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ code: 'destination_dirty' })
    expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.worktree.baseSha)
    await expect(fs.readFile(path.join(managed.repo, 'untracked.txt'), 'utf-8')).resolves.toBe('local work')
    expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toContain(managed.worktree.branch)
    expect(await managed.manifests.read('wf-1', 'run-dirty')).toMatchObject({
      disposition: 'ready',
      actionError: { action: 'apply', code: 'destination_dirty' },
    })
  })

  it('rejects moved destination HEAD without losing the result branch', async () => {
    const managed = await createReadyRun('run-head-moved')
    await fs.writeFile(path.join(managed.repo, 'main-only.txt'), 'new base work')
    git(managed.repo, 'add', '-A')
    git(managed.repo, 'commit', '-m', 'destination moved')
    const movedHead = git(managed.repo, 'rev-parse', 'HEAD')

    const response = await fetch(`${base}/api/runs/run-head-moved/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ code: 'destination_moved' })
    expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(movedHead)
    expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toContain(managed.worktree.branch)
  })

  it('rejects missing result objects and tampered result refs', async () => {
    const missing = await createReadyRun('run-result-missing', 'f'.repeat(40))
    const missingResponse = await fetch(`${base}/api/runs/run-result-missing/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(missingResponse.status).toBe(409)
    expect((await missingResponse.json()) as Record<string, unknown>).toMatchObject({ code: 'result_missing' })
    expect(git(missing.repo, 'branch', '--list', missing.worktree.branch)).toContain(missing.worktree.branch)

    const moved = await createReadyRun('run-branch-moved')
    git(moved.repo, 'branch', '-f', moved.worktree.branch, moved.worktree.baseSha)
    const movedResponse = await fetch(`${base}/api/runs/run-branch-moved/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(movedResponse.status).toBe(409)
    expect((await movedResponse.json()) as Record<string, unknown>).toMatchObject({ code: 'branch_moved' })
    expect(git(moved.repo, 'rev-parse', 'HEAD')).toBe(moved.worktree.baseSha)
  })

  it('rejects a non-descendant result even when the recorded branch and SHA agree', async () => {
    const managed = await createReadyRun('run-unrelated')
    const tree = git(managed.repo, 'rev-parse', `${managed.worktree.baseSha}^{tree}`)
    const unrelated = git(managed.repo, 'commit-tree', tree, '-m', 'unrelated result')
    git(managed.repo, 'update-ref', `refs/heads/${managed.worktree.branch}`, unrelated)
    await managed.manifests.transition('wf-1', 'run-unrelated', manifest => ({ ...manifest, resultSha: unrelated }))

    const response = await fetch(`${base}/api/runs/run-unrelated/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ code: 'non_descendant' })
    expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.worktree.baseSha)
  })

  it('requires confirmation, then discards only the verified CWC branch exactly once', async () => {
    const managed = await createReadyRun('run-discard')
    const withoutConfirmation = await fetch(`${base}/api/runs/run-discard/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(withoutConfirmation.status).toBe(400)

    const first = await fetch(`${base}/api/runs/run-discard/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ discarded: true, disposition: 'discarded', resultSha: managed.actualResultSha })
    expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toBe('')
    expect(git(managed.repo, 'branch', '--show-current')).toBe('main')
    expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.worktree.baseSha)

    const repeated = await fetch(`${base}/api/runs/run-discard/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })
    expect(repeated.status).toBe(409)
    expect((await repeated.json()) as Record<string, unknown>).toMatchObject({ code: 'already_discarded' })
  })

  it('allows Discard but never Apply for a failed run with a preserved result', async () => {
    const managed = await createReadyRun('run-failed-result')
    await managed.manifests.transition('wf-1', 'run-failed-result', manifest => ({
      ...manifest,
      lifecycleState: 'failed',
      completionStatus: 'error',
      failureReason: 'workflow failed after producing output',
    }))

    const apply = await fetch(`${base}/api/runs/run-failed-result/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(apply.status).toBe(409)
    expect((await apply.json()) as Record<string, unknown>).toMatchObject({ code: 'not_applicable' })

    const discard = await fetch(`${base}/api/runs/run-failed-result/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })
    expect(discard.status).toBe(200)
    expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toBe('')
  })

  it('protects a renamed/foreign branch and records the failed Discard preflight', async () => {
    const managed = await createReadyRun('run-foreign')
    const foreign = 'user/kept-result'
    git(managed.repo, 'branch', '-m', managed.worktree.branch, foreign)

    const response = await fetch(`${base}/api/runs/run-foreign/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ code: 'branch_missing' })
    expect(git(managed.repo, 'branch', '--list', foreign)).toContain(foreign)
    expect(await managed.manifests.read('wf-1', 'run-foreign')).toMatchObject({
      disposition: 'ready',
      actionError: { action: 'discard', code: 'branch_missing' },
    })
  })

  it('serializes concurrent Apply and Discard so only one disposition succeeds', async () => {
    const managed = await createReadyRun('run-race')

    const [apply, discard] = await Promise.all([
      fetch(`${base}/api/runs/run-race/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
      }),
      fetch(`${base}/api/runs/run-race/discard`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
      }),
    ])

    expect([apply.status, discard.status].sort()).toEqual([200, 409])
    const manifest = await managed.manifests.read('wf-1', 'run-race')
    expect(['applied', 'discarded']).toContain(manifest?.disposition)
    if (manifest?.disposition === 'applied') {
      expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.actualResultSha)
      expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toContain(managed.worktree.branch)
    } else {
      expect(git(managed.repo, 'rev-parse', 'HEAD')).toBe(managed.worktree.baseSha)
      expect(git(managed.repo, 'branch', '--list', managed.worktree.branch)).toBe('')
    }
  })

  it('reconciles interrupted applying and discarding dispositions after restart', async () => {
    const applying = await createReadyRun('run-applying-restart')
    await applying.manifests.transition('wf-1', 'run-applying-restart', manifest => ({ ...manifest, disposition: 'applying' }))
    git(applying.repo, 'merge', '--ff-only', applying.actualResultSha)

    const applyResponse = await fetch(`${base}/api/runs/run-applying-restart/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    expect(applyResponse.status).toBe(200)
    expect(await applying.manifests.read('wf-1', 'run-applying-restart')).toMatchObject({ disposition: 'applied', appliedSha: applying.actualResultSha })

    const discarding = await createReadyRun('run-discarding-restart')
    await discarding.manifests.transition('wf-1', 'run-discarding-restart', manifest => ({ ...manifest, disposition: 'discarding' }))
    git(discarding.repo, 'update-ref', '-d', `refs/heads/${discarding.worktree.branch}`, discarding.actualResultSha)

    const discardResponse = await fetch(`${base}/api/runs/run-discarding-restart/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })
    expect(discardResponse.status).toBe(200)
    expect(await discarding.manifests.read('wf-1', 'run-discarding-restart')).toMatchObject({ disposition: 'discarded' })
  })

  it('returns 404 for unknown managed result actions', async () => {
    const apply = await fetch(`${base}/api/runs/run-unknown/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1' }),
    })
    const discard = await fetch(`${base}/api/runs/run-unknown/discard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'wf-1', confirmed: true }),
    })
    expect(apply.status).toBe(404)
    expect(discard.status).toBe(404)
  })
})
