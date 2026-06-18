// src/server/api/automation-scan.ts
import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { runClaude as defaultRunner, type ClaudeRunner } from '../claude-runner.js'
import { findTranscripts, parseSession } from '../../detection/transcript-parser.js'
import { analyzeUnits } from '../../detection/analyzer.js'
import type { TaskUnit, DetectedAutomation } from '../../detection/types.js'
import type { ScanStore } from '../scan-store.js'
import { buildWorkflowGenPrompt, parseWorkflowJson } from '../../workflow-generator.js'
import { slugify } from '../../slugify.js'
import type { CwcTrigger } from '../../schema.js'

export interface AutomationScanRouterOptions {
  homeDir: string
  workflowsDir: string
  store: ScanStore
  runner?: ClaudeRunner
}

export function automationScanRouter(opts: AutomationScanRouterOptions): Router {
  const runner = opts.runner ?? defaultRunner
  const router = Router()

  router.get('/', (_req, res) => {
    res.json(opts.store.getLatest() ?? { status: 'idle', automations: [] })
  })

  router.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const off = opts.store.onProgress(p => res.write(`data: ${JSON.stringify(p)}\n\n`))
    req.on('close', () => { off(); res.end() })
  })

  router.post('/', (_req, res) => {
    if (opts.store.isRunning()) return void res.status(409).json({ error: 'A scan is already running.' })
    res.status(202).json({ status: 'running' })
    void opts.store.runScan(async () => {
      opts.store.emitProgress({ stage: 'reading' })
      const files = await findTranscripts(opts.homeDir)
      const units: TaskUnit[] = []
      for (const f of files) units.push(...await parseSession(f))
      opts.store.emitProgress({ stage: 'analyzing', detail: `${units.length} tasks` })
      const found = await analyzeUnits(units, runner)
      opts.store.emitProgress({ stage: 'done', detail: `${found.length} found` })
      return found
    }).catch(() => { /* store records the error */ })
  })

  router.post('/:id/dismiss', async (req, res) => {
    const a = await opts.store.setStatus(req.params.id, 'dismissed')
    if (!a) return void res.status(404).json({ error: 'not found' })
    res.json({ ok: true })
  })

  router.post('/:id/promote', async (req, res) => {
    const a = opts.store.getLatest()?.automations.find(x => x.id === req.params.id)
    if (!a) return void res.status(404).json({ error: 'not found' })
    try {
      const out = await runner(buildWorkflowGenPrompt(a))
      const cwc = parseWorkflowJson(out.result)
      // Overwrite the LLM-generated id with a server-assigned UUID to guarantee
      // uniqueness and safe post-promote navigation (/w/<id>/build).
      cwc.meta.id = randomUUID()
      cwc.meta.triggers = [cronTriggerFor(a)]
      const file = path.join(opts.workflowsDir, `${slugify(cwc.meta.name)}-${Date.now()}.cwc`)
      await fs.mkdir(opts.workflowsDir, { recursive: true })
      await fs.writeFile(file, JSON.stringify(cwc, null, 2))
      await opts.store.setStatus(a.id, 'promoted')
      res.json({ workflowId: cwc.meta.id })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'promote failed' })
    }
  })

  return router
}

/** A disabled, unarmed cron trigger seeded from the automation; user confirms + arms in the UI. */
function cronTriggerFor(a: DetectedAutomation): CwcTrigger {
  const schedule = a.suggestedTrigger.cron && isValidCron(a.suggestedTrigger.cron) ? a.suggestedTrigger.cron : '0 9 * * *'
  return {
    id: 'trig-' + Math.random().toString(16).slice(2, 10),
    type: 'cron', schedule,
    cwd: a.evidence.repos[0] ?? process.cwd(),
    isolation: 'worktree', baseRef: 'HEAD',
    catchUp: false, maxRunsPerDay: 1, enabled: false,
  }
}

function isValidCron(expr: string): boolean {
  try { new Cron(expr); return true } catch { return false }
}
