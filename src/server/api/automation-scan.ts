// src/server/api/automation-scan.ts
import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { runClaude as defaultRunner, type ClaudeRunner } from '../claude-runner.js'
import { findTranscripts, parseSession } from '../../detection/transcript-parser.js'
import { buildAnalysisContext, parseAutomations } from '../../detection/analyzer.js'
import { runClaudeStreaming, type StreamingRunner } from '../streaming-analyzer.js'
import type { TaskUnit, DetectedAutomation } from '../../detection/types.js'
import type { ScanStore } from '../scan-store.js'
import { buildWorkflowGenPrompt, parseWorkflowJson } from '../../workflow-generator.js'
import { listReusableSkills, selectRelevantSkills } from '../skill-catalog.js'
import { slugify } from '../../slugify.js'
import type { CwcTrigger } from '../../schema.js'

export interface AutomationScanRouterOptions {
  homeDir: string
  workflowsDir: string
  store: ScanStore
  runner?: ClaudeRunner
  streamingRunner?: StreamingRunner
  genModel?: string         // model for Promote's workflow generation; default Sonnet
}

/** Models the scan analysis may run on (friendly key → CLI model id). Allowlisted so a request can't pass an arbitrary --model. */
export const SCAN_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
}

function resolveScanModel(key: unknown): { id: string; label: string } {
  if (typeof key === 'string' && key in SCAN_MODELS) return { id: SCAN_MODELS[key], label: key }
  return { id: SCAN_MODELS['sonnet'], label: 'sonnet' }
}

export function automationScanRouter(opts: AutomationScanRouterOptions): Router {
  const runner = opts.runner ?? defaultRunner
  const streamingRunner = opts.streamingRunner ?? runClaudeStreaming
  const router = Router()

  router.get('/', (_req, res) => {
    res.json(opts.store.getLatest() ?? { status: 'idle', automations: [] })
  })

  router.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const off = opts.store.onLog(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
    req.on('close', () => { off(); res.end() })
  })

  router.post('/', (req, res) => {
    if (opts.store.isRunning()) return void res.status(409).json({ error: 'A scan is already running.' })
    const model = resolveScanModel((req.body ?? {}).model)
    res.status(202).json({ status: 'running' })
    void opts.store.runScan(async () => {
      const files = await findTranscripts(opts.homeDir)
      opts.store.appendLog({ level: 'info', message: `Found ${files.length} transcript file(s)` })
      const units: TaskUnit[] = []
      for (const f of files) units.push(...await parseSession(f))
      opts.store.appendLog({ level: 'info', message: `Parsed ${units.length} task unit(s)` })
      const ctx = buildAnalysisContext(units)
      if (!ctx) { opts.store.appendLog({ level: 'info', message: 'No meaningful history to analyze yet.' }); return [] }
      opts.store.appendLog({ level: 'info', message: `Analyzing ${ctx.refIndex.size} digest line(s) with Claude (${model.label})…` })
      const { resultText } = await streamingRunner(ctx.prompt, { onLog: e => opts.store.appendLog(e), model: model.id })
      const found = parseAutomations(resultText, ctx.refIndex)
      opts.store.appendLog({ level: 'info', message: `${found.length} automation(s) detected` })
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
      const skills = selectRelevantSkills(await listReusableSkills(opts.homeDir), a)
      const out = await runner(buildWorkflowGenPrompt(a, skills), { model: opts.genModel ?? 'claude-sonnet-4-6' })
      const cwc = parseWorkflowJson(out.result)
      // Drop any hallucinated skill slugs — keep only skills the user actually has.
      const validSlugs = new Set(skills.map(s => s.slug))
      for (const n of cwc.nodes) n.agent.skills = (n.agent.skills ?? []).filter(s => validSlugs.has(s))
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
