// src/server/api/runs.ts
import { Router } from 'express'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import { validateRunEvent, type RunEvent } from '../../run-events.js'
import type { RunStore, RunSummary } from '../run-store.js'
import { runWorkflowSkill } from '../workflow-runner.js'
import { fireWorkflow, classifyAndFinish } from '../run-launcher.js'
import { isGitRepo, removeWorktree, getDiff } from '../run-isolation.js'

export interface RunsRouterOptions {
  store: RunStore
  claudeBinPath?: string   // test injection
  worktreesRoot: string
  runsDirPath: string
  skillsDir: string        // ~/.claude/skills — used to verify a workflow is exported before a test run
}

export function runsRouter(opts: RunsRouterOptions): Router {
  const { store } = opts
  const router = Router()

  async function ingest(event: RunEvent): Promise<void> {
    await store.append(event)   // append also fans out to SSE subscribers
  }

  router.post('/events', async (req, res) => {
    const outcome = validateRunEvent(req.body)
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error })
      return
    }
    try {
      await ingest(outcome.event)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to persist event' })
    }
  })

  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const off = store.onEvent(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 30_000)
    req.on('close', () => { off(); clearInterval(heartbeat) })
  })

  router.post('/test', async (req, res) => {
    const { workflowId, workflowSlug, cwd, isolation: isolationBody } = (req.body ?? {}) as {
      workflowId?: string; workflowSlug?: string; cwd?: string; isolation?: 'worktree' | 'in-place'
    }
    if (!workflowId || !workflowSlug || !cwd) {
      res.status(400).json({ error: 'workflowId, workflowSlug, and cwd are required' })
      return
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      res.status(400).json({ error: `working directory does not exist: ${cwd}` })
      return
    }
    // The run spawns `claude -p "/<slug>"`; if the skill isn't on disk the slash command
    // silently resolves to nothing and the run is a confusing no-op. Verify it's exported.
    // A rename changes the slug, so this also catches "exported, then renamed, not re-exported".
    if (!fs.existsSync(path.join(opts.skillsDir, workflowSlug, 'SKILL.md'))) {
      res.status(400).json({ error: `workflow not exported: no skill found for /${workflowSlug}. Export the workflow first (re-export if you renamed it).` })
      return
    }
    if (store.hasActiveTestRun(workflowId)) {
      res.status(409).json({ error: 'a test run for this workflow is already active' })
      return
    }
    // Default isolation: worktree if git repo, else in-place
    let isolation: 'worktree' | 'in-place'
    if (isolationBody) {
      isolation = isolationBody
    } else {
      isolation = (await isGitRepo(cwd)) ? 'worktree' : 'in-place'
    }
    const outcome = await fireWorkflow({
      workflowId, workflowSlug, cwd, isolation, trigger: 'manual',
      store, worktreesRoot: opts.worktreesRoot, binPath: opts.claudeBinPath,
    })
    if (!outcome.fired) {
      res.status(400).json({ error: outcome.reason })
      return
    }
    res.json({ runId: outcome.runId })
  })

  // GET /paused — global inbox. MUST be registered before '/:runId/events'.
  router.get('/paused', async (_req, res) => {
    const all: RunSummary[] = []
    let dirs: string[] = []
    try { dirs = await fsPromises.readdir(opts.runsDirPath) } catch { /* none yet */ }
    for (const wf of dirs) {
      for (const run of await store.listRuns(wf)) if (run.status === 'paused') all.push(run)
    }
    res.json(all.sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt)))
  })

  // GET /recent — cross-workflow recent runs, newest first. MUST be before '/:runId/...'.
  router.get('/recent', async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
    const all: RunSummary[] = []
    let dirs: string[] = []
    try { dirs = await fsPromises.readdir(opts.runsDirPath) } catch { /* none yet */ }
    for (const wf of dirs) all.push(...await store.listRuns(wf))
    all.sort((a, b) => Date.parse(b.lastEventAt ?? b.startedAt) - Date.parse(a.lastEventAt ?? a.startedAt))
    res.json(all.slice(0, limit))
  })

  router.post('/:runId/stop', (req, res) => {
    if (!store.stopRun(req.params.runId)) {
      res.status(404).json({ error: 'no active test run with that id' })
      return
    }
    res.json({ stopped: true })
  })

  router.get('/:runId/events', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId query param is required' })
      return
    }
    const events = await store.getEvents(workflowId, req.params.runId)
    if (events === null) {
      res.status(404).json({ error: 'run not found' })
      return
    }
    res.json(events)
  })

  router.get('/:runId/diff', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    const events = await store.getEvents(workflowId, req.params.runId)
    if (!events) return void res.status(404).json({ error: 'run not found' })
    const started = events.find(e => e.type === 'run_started')
    const dir = started?.worktreePath ?? started?.cwd
    if (!started?.baseSha || !dir) return void res.json({ diff: null, status: null, branch: started?.branch ?? null })
    try {
      const d = await getDiff(dir, started.baseSha)
      res.json({ ...d, branch: started.branch ?? null })
    } catch (err) {
      res.json({ diff: null, status: null, branch: started.branch ?? null, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/:runId/approve', async (req, res) => {
    const { workflowId, note } = (req.body ?? {}) as { workflowId?: string; note?: string }
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    const runId = req.params.runId
    // Claim the run synchronously (no await between the check and the reserve) so a
    // rapid second Approve click can't also spawn a resume. A paused run has already
    // been released from the active registry, so the first claim wins; the rest 409.
    if (store.hasActiveTestRun(workflowId)) {
      return void res.status(409).json({ error: 'a run for this workflow is already active' })
    }
    store.registerRun(runId, workflowId, () => { /* placeholder until the resume spawns */ })
    const bail = (code: number, error: string) => { store.releaseRun(runId); res.status(code).json({ error }) }

    const events = await store.getEvents(workflowId, runId)
    if (!events) return void bail(404, 'run not found')
    const last = events[events.length - 1]
    if (last.type !== 'run_paused' && last.type !== 'awaiting_approval') return void bail(409, 'run is not paused')
    if (last.type !== 'run_paused' || !last.sessionId) return void bail(409, "cannot resume this run from CWC — it was started from a terminal. Continue it where you launched it, or reject it to clean up.")
    const started = events.find(e => e.type === 'run_started')!
    const runCwd = last.worktreePath ?? started.worktreePath ?? started.cwd!
    const wt = started.worktreePath && started.branch
      ? { worktreePath: started.worktreePath, branch: started.branch, baseSha: started.baseSha ?? '' }
      : null
    const prompt = `Approved — continue the workflow from the gate.${note ? `\nNote from the reviewer: ${note}` : ''}`
    // Human action: bypasses the scheduler queue/cap by design (Addendum 2).
    const { stop, done } = runWorkflowSkill({ slug: started.workflowSlug, runId, cwd: runCwd, binPath: opts.claudeBinPath, resume: last.sessionId, promptOverride: prompt })
    store.registerRun(runId, workflowId, stop)
    void done.then(result => classifyAndFinish({
      workflowId, workflowSlug: started.workflowSlug, cwd: started.cwd ?? runCwd,
      isolation: wt ? 'worktree' : 'in-place', trigger: started.trigger ?? 'manual',
      store, worktreesRoot: opts.worktreesRoot, runId, wt, result,
    }))
    res.json({ resumed: true })
  })

  router.post('/:runId/reject', async (req, res) => {
    const { workflowId, note } = (req.body ?? {}) as { workflowId?: string; note?: string }
    if (!workflowId) return void res.status(400).json({ error: 'workflowId required' })
    const events = await store.getEvents(workflowId, req.params.runId)
    if (!events) return void res.status(404).json({ error: 'run not found' })
    const last = events[events.length - 1]
    if (last.type !== 'run_paused' && last.type !== 'awaiting_approval') return void res.status(409).json({ error: 'run is not paused' })
    const started = events.find(e => e.type === 'run_started')
    await store.append({
      runId: req.params.runId, workflowId, workflowSlug: started?.workflowSlug ?? '', type: 'run_completed',
      ts: new Date().toISOString(), status: 'aborted', source: started?.source ?? 'external',
      message: `Rejected by reviewer${note ? `: ${note}` : ''}`,
    })
    if (started?.worktreePath && started.branch && started.cwd) {
      await removeWorktree(started.cwd, started.worktreePath, started.branch, { keepBranch: false })
    }
    res.json({ rejected: true })
  })

  router.get('/', async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId query param is required' })
      return
    }
    res.json(await store.listRuns(workflowId))
  })

  return router
}
