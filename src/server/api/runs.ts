// src/server/api/runs.ts
import { Router } from 'express'
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { validateRunEvent, type RunEvent } from '../../run-events.js'
import type { RunStore } from '../run-store.js'
import { runWorkflowSkill } from '../workflow-runner.js'

export interface RunsRouterOptions {
  store: RunStore
  claudeBinPath?: string   // test injection
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
    const { workflowId, workflowSlug, cwd } = (req.body ?? {}) as { workflowId?: string; workflowSlug?: string; cwd?: string }
    if (!workflowId || !workflowSlug || !cwd) {
      res.status(400).json({ error: 'workflowId, workflowSlug, and cwd are required' })
      return
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      res.status(400).json({ error: `working directory does not exist: ${cwd}` })
      return
    }
    if (store.hasActiveTestRun(workflowId)) {
      res.status(409).json({ error: 'a test run for this workflow is already active' })
      return
    }
    const runId = `run-${randomUUID().slice(0, 13)}`
    const { child, done } = runWorkflowSkill({ slug: workflowSlug, runId, cwd, binPath: opts.claudeBinPath })
    store.registerChild(runId, workflowId, child)
    const now = () => new Date().toISOString()
    await ingest({ runId, workflowId, workflowSlug, type: 'run_started', ts: now(), source: 'test', cwd, message: 'Test run started from CWC' })
    void done.then(async result => {
      store.releaseChild(runId)
      await ingest({
        runId, workflowId, workflowSlug, type: 'run_completed', ts: now(),
        status: result.status, message: result.message, costUsd: result.costUsd, source: 'test',
      }).catch(() => { /* run dir may be gone in teardown */ })
    })
    res.json({ runId })
  })

  router.post('/:runId/stop', (req, res) => {
    const child = store.getChild(req.params.runId)
    if (!child) {
      res.status(404).json({ error: 'no active test run with that id' })
      return
    }
    child.kill('SIGTERM')
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
