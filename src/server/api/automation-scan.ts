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
import { buildCapabilityCards, listReusableAgents, listReusableSkills, selectRelevantAgents, selectRelevantSkills } from '../skill-catalog.js'
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
  let activePromotion: { id: string; controller: AbortController } | null = null

  function hasPromotionWork(): boolean {
    return opts.store.hasActivePromotion() || activePromotion !== null
  }

  function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Workflow generation cancelled.')
  }

  async function markPromotionCancelled(id: string): Promise<void> {
    const current = opts.store.getLatest()?.automations.find(a => a.id === id)
    if (current?.status !== 'promotion_cancelled') {
      opts.store.appendLog({ level: 'info', message: 'Workflow generation cancelled' })
      await opts.store.setStatus(id, 'promotion_cancelled', 'Workflow generation was cancelled.')
    }
  }

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
    if (hasPromotionWork()) return void res.status(409).json({ error: 'A workflow generation is already running.' })
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
    if (hasPromotionWork()) return void res.status(409).json({ error: 'A workflow generation is already running.' })
    const a = await opts.store.setStatus(req.params.id, 'dismissed')
    if (!a) return void res.status(404).json({ error: 'not found' })
    res.json({ ok: true })
  })

  router.post('/:id/promote/cancel', async (req, res) => {
    const a = opts.store.getLatest()?.automations.find(x => x.id === req.params.id)
    if (!a) return void res.status(404).json({ error: 'not found' })
    if (a.status !== 'promoting') return void res.status(409).json({ error: 'No workflow generation is running for this automation.' })
    if (activePromotion?.id === a.id) activePromotion.controller.abort()
    await markPromotionCancelled(a.id)
    res.json({ cancelled: true })
  })

  router.post('/:id/promote', async (req, res) => {
    if (opts.store.isRunning()) return void res.status(409).json({ error: 'A scan is already running.' })
    if (hasPromotionWork()) return void res.status(409).json({ error: 'A workflow generation is already running.' })
    const a = opts.store.getLatest()?.automations.find(x => x.id === req.params.id)
    if (!a) return void res.status(404).json({ error: 'not found' })
    const controller = new AbortController()
    activePromotion = { id: a.id, controller }
    try {
      const startedAt = Date.now()
      await opts.store.setStatus(a.id, 'promoting')
      opts.store.appendLog({ level: 'info', message: `Generating workflow for "${a.title}"` })
      opts.store.appendLog({ level: 'info', message: 'Selecting matching skills and agents' })
      const skills = selectRelevantSkills(await listReusableSkills(opts.homeDir), a)
      throwIfCancelled(controller.signal)
      const agents = selectRelevantAgents(await listReusableAgents(opts.homeDir), a)
      throwIfCancelled(controller.signal)
      opts.store.appendLog({ level: 'info', message: `Reading ${Math.min(skills.length, 5)} skill and ${Math.min(agents.length, 5)} agent capability file(s)` })
      const capabilityCards = await buildCapabilityCards({ skills, agents, maxSkills: 5, maxAgents: 5 })
      throwIfCancelled(controller.signal)
      opts.store.appendLog({ level: 'info', message: 'Asking Claude to compose the workflow' })
      const out = await runner(buildWorkflowGenPrompt(a, { skills, agents, capabilityCards }), { model: opts.genModel ?? 'claude-sonnet-4-6', signal: controller.signal })
      throwIfCancelled(controller.signal)
      opts.store.appendLog({ level: 'info', message: 'Validating generated workflow JSON' })
      const cwc = parseWorkflowJson(out.result)
      // Keep only real skills/agent refs. Skills are capped to one per bespoke agent;
      // reference nodes must stay pure references because the existing agent owns its behavior.
      const validSlugs = new Set(skills.map(s => s.slug))
      const validAgentRefs = new Set(agents.map(a => a.slug))
      for (const n of cwc.nodes) {
        if (n.agentRef && validAgentRefs.has(n.agentRef)) {
          n.agent.skills = []
          n.agent.tools = []
          n.agent.systemPrompt = ''
          n.agent.completionCriteria = ''
        } else {
          delete n.agentRef
          n.agent.skills = (n.agent.skills ?? []).filter(s => validSlugs.has(s)).slice(0, 1)
        }
      }
      // Overwrite the LLM-generated id with a server-assigned UUID to guarantee
      // uniqueness and safe post-promote navigation (/w/<id>/build).
      const now = new Date().toISOString()
      cwc.meta.id = randomUUID()
      cwc.meta.created = now
      cwc.meta.updated = now
      cwc.meta.triggers = triggersForAutomation(a)
      const file = path.join(opts.workflowsDir, `${slugify(cwc.meta.name)}-${Date.now()}.cwc`)
      await fs.mkdir(opts.workflowsDir, { recursive: true })
      await fs.writeFile(file, JSON.stringify(cwc, null, 2))
      opts.store.appendLog({ level: 'info', message: `Generated workflow "${cwc.meta.name}" in ${Math.round((Date.now() - startedAt) / 1000)}s` })
      await opts.store.setStatus(a.id, 'promoted')
      res.json({ workflowId: cwc.meta.id })
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && /cancelled/i.test(err.message))) {
        await markPromotionCancelled(a.id)
        res.status(499).json({ cancelled: true, error: 'Workflow generation cancelled.' })
        return
      }
      const message = err instanceof Error ? err.message : 'promote failed'
      opts.store.appendLog({ level: 'error', message: `Workflow generation failed: ${message}` })
      await opts.store.setStatus(a.id, 'promotion_failed', message)
      res.status(502).json({ error: message })
    } finally {
      if (activePromotion?.id === a.id && activePromotion.controller === controller) activePromotion = null
    }
  })

  return router
}

/**
 * Seed triggers from the automation's detected shape. Only SCHEDULE-shaped automations get a
 * cron trigger — manual/event ones become plain on-demand workflows (no schedule shoehorned on).
 */
export function triggersForAutomation(a: DetectedAutomation): CwcTrigger[] {
  return a.suggestedTrigger.kind === 'schedule' ? [cronTriggerFor(a)] : []
}

/** A disabled, unarmed cron trigger seeded from the automation; user confirms + arms in the UI. */
function cronTriggerFor(a: DetectedAutomation): CwcTrigger {
  const schedule = a.suggestedTrigger.cron && isValidCron(a.suggestedTrigger.cron) ? a.suggestedTrigger.cron : '0 9 * * *'
  return {
    id: 'trig-' + Math.random().toString(16).slice(2, 10),
    type: 'cron', schedule,
    cwd: '',
    isolation: 'worktree', baseRef: 'HEAD',
    catchUp: false, maxRunsPerDay: 1, enabled: false,
  }
}

function isValidCron(expr: string): boolean {
  try { new Cron(expr); return true } catch { return false }
}
