// src/server/api/automation-scan.ts
import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { runClaude as defaultRunner, type ClaudeRunner } from '../claude-runner.js'
import { discoverTranscripts, parseSessionDetailed } from '../../detection/transcript-parser.js'
import { envSnapshot, redact, totalsOf, type ClaudeProbe, type ScanDiagnostics, type ScanStage } from '../../detection/scan-diagnostics.js'
import { buildAnalysisContext, parseAutomations } from '../../detection/analyzer.js'
import { runClaudeStreaming, type StreamingRunner } from '../streaming-analyzer.js'
import type { TaskUnit, DetectedAutomation } from '../../detection/types.js'
import type { ScanStore } from '../scan-store.js'
import { buildWorkflowGenPrompt, parseWorkflowJson } from '../../generation/workflow-generator.js'
import { buildCapabilityCards, listReusableAgents, listReusableSkills, selectRelevantAgents, selectRelevantSkills } from '../skill-catalog.js'
import { slugify } from '../../slugify.js'
import type { CwcFile, CwcTrigger } from '../../schema.js'
import { generateWorkflow } from '../../generation/generate.js'

export interface AutomationScanRouterOptions {
  homeDir: string
  workflowsDir: string
  store: ScanStore
  runner?: ClaudeRunner
  streamingRunner?: StreamingRunner
  genModel?: string         // model for Promote's workflow generation; default Sonnet
  claudeProbe?: ClaudeProbe // injectable `claude --version` probe for diagnostics
  cwcVersion?: string       // reported in the diagnostics bundle
}

/** Models the scan analysis may run on (friendly key → CLI model id). Allowlisted so a request can't pass an arbitrary --model. */
const SCAN_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
}

function resolveScanModel(key: unknown): { id: string; label: string } {
  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(SCAN_MODELS, key)) {
    return { id: SCAN_MODELS[key], label: key }
  }
  return { id: SCAN_MODELS['sonnet'], label: 'sonnet' }
}

export function automationScanRouter(opts: AutomationScanRouterOptions): Router {
  const runner = opts.runner ?? defaultRunner
  const streamingRunner = opts.streamingRunner ?? runClaudeStreaming
  const router = Router()
  let activePromotion: { id: string; controller: AbortController } | null = null
  let scanStarting = false

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
    const generation = opts.store.getGeneration()
    await opts.store.setGeneration({
      id,
      step: 'cancelled',
      startedAt: generation?.id === id ? generation.startedAt : new Date().toISOString(),
      error: 'Workflow generation was cancelled.',
    })
  }

  async function generateLegacyWorkflow(a: DetectedAutomation, controller: AbortController): Promise<CwcFile> {
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
    throwIfCancelled(controller.signal)

    const validSlugs = new Set(skills.map(s => s.slug))
    const validAgentRefs = new Set(agents.map(agent => agent.slug))
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
    return cwc
  }

  async function generatePromotionWorkflow(a: DetectedAutomation, controller: AbortController): Promise<CwcFile> {
    if (process.env['CWC_LEGACY_GEN'] === '1') return generateLegacyWorkflow(a, controller)
    return generateWorkflow({
      automation: a,
      homeDir: opts.homeDir,
      runner,
      model: opts.genModel ?? 'claude-sonnet-4-6',
      signal: controller.signal,
      triggers: triggersForAutomation(a),
      onLog: message => opts.store.appendLog({ level: 'info', message }),
    })
  }

  router.get('/', (_req, res) => {
    res.json(opts.store.getLatest() ?? { status: 'idle', automations: [] })
  })

  router.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const off = opts.store.onLog(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
    req.on('close', () => { off(); res.end() })
  })

  router.post('/', async (req, res) => {
    if (scanStarting || opts.store.isRunning()) return void res.status(409).json({ error: 'A scan is already running.' })
    if (hasPromotionWork()) return void res.status(409).json({ error: 'A workflow generation is already running.' })
    scanStarting = true
    const model = resolveScanModel((req.body ?? {}).model)
    // Gate: Detect's analysis stage spawns `claude -p`; without the binary every scan
    // dies mid-flight with an opaque ENOENT. Probe once up front (result is reused as
    // the diagnostics env snapshot) and refuse with an actionable message instead.
    const env = await envSnapshot(opts.cwcVersion ?? 'unknown', opts.claudeProbe).catch(err => {
      scanStarting = false
      throw err
    })
    if (!env.claude.found) {
      scanStarting = false
      return void res.status(422).json({
        error: 'Claude Code CLI not found — the `claude` command is not on this server\'s PATH, and Detect needs it to analyze your history. Install Claude Code, verify `claude --version` works in a terminal, then restart CWC and retry. (Run `npx claude-cwc doctor` for a full environment check.)',
      })
    }
    res.status(202).json({ status: 'running' })
    void opts.store.runScan(async () => {
      const diag: ScanDiagnostics = {
        generatedAt: new Date().toISOString(),
        env,
        discovery: { root: '', rootExists: false, projectDirs: 0, unreadableDirs: 0, transcriptFiles: 0 },
        files: [],
        totals: totalsOf([]),
      }
      let stage: ScanStage = 'discovery'
      try {
        const { files, stats } = await discoverTranscripts(opts.homeDir)
        diag.discovery = stats
        const unreadable = stats.unreadableDirs ? `, ${stats.unreadableDirs} unreadable entr${stats.unreadableDirs === 1 ? 'y' : 'ies'}` : ''
        opts.store.appendLog({ level: 'info', message: `Found ${files.length} transcript file(s) across ${stats.projectDirs} project dir(s)${unreadable}` })
        stage = 'parse'
        const units: TaskUnit[] = []
        for (const f of files) {
          const parsed = await parseSessionDetailed(f, opts.homeDir)
          units.push(...parsed.units)
          diag.files.push(parsed.stats)
        }
        diag.totals = totalsOf(diag.files)
        const skipped = diag.totals.jsonErrors ? `; ${diag.totals.jsonErrors} unparseable line(s) skipped` : ''
        const failedReads = diag.totals.filesWithReadErrors ? `; ${diag.totals.filesWithReadErrors} file(s) unreadable` : ''
        opts.store.appendLog({ level: 'info', message: `Parsed ${units.length} task unit(s)${skipped}${failedReads}` })
        stage = 'digest'
        const ctx = buildAnalysisContext(units)
        if (!ctx) {
          await opts.store.setDiagnostics(diag)
          opts.store.appendLog({ level: 'info', message: 'No meaningful history to analyze yet.' })
          return []
        }
        stage = 'analysis'
        opts.store.appendLog({ level: 'info', message: `Analyzing ${ctx.refIndex.size} digest line(s) with Claude (${model.label})…` })
        const { resultText } = await streamingRunner(ctx.prompt, { onLog: e => opts.store.appendLog(e), model: model.id })
        stage = 'parse-response'
        const found = parseAutomations(resultText, ctx.refIndex)
        opts.store.appendLog({ level: 'info', message: `${found.length} automation(s) detected` })
        await opts.store.setDiagnostics(diag)
        return found
      } catch (err) {
        diag.failure = { stage, message: redact(err instanceof Error ? err.message : String(err), opts.homeDir) }
        await opts.store.setDiagnostics(diag)
        opts.store.appendLog({ level: 'error', message: `Scan failed during ${stage}: ${diag.failure.message}` })
        throw err
      }
    }).catch(() => { /* store records the error */ }).finally(() => { scanStarting = false })
  })

  router.get('/diagnostics', (_req, res) => {
    const d = opts.store.getLatest()?.diagnostics
    if (!d) return void res.status(404).json({ error: 'No scan diagnostics recorded yet. Run a scan first.' })
    res.json(d)
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
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()

    await opts.store.setStatus(a.id, 'promoting')
    await opts.store.setGeneration({ id: a.id, step: 'planning', startedAt })
    res.status(202).json({ status: 'generating' })

    const job = (async () => {
      let tempWorkflowFile: string | null = null
      let finalWorkflowFile: string | null = null
      try {
        await opts.store.setStatus(a.id, 'promoting')
        opts.store.appendLog({ level: 'info', message: `Generating workflow for "${a.title}"` })
        const cwc = await generatePromotionWorkflow(a, controller)
        throwIfCancelled(controller.signal)

        // Overwrite the LLM-generated id with a server-assigned UUID to guarantee
        // uniqueness and safe post-promote navigation (/w/<id>/build).
        const now = new Date().toISOString()
        cwc.meta.id = randomUUID()
        cwc.meta.created = now
        cwc.meta.updated = now
        cwc.meta.triggers = triggersForAutomation(a)
        throwIfCancelled(controller.signal)

        await opts.store.setGeneration({ id: a.id, step: 'writing', startedAt })
        const workflowSlug = slugify(cwc.meta.name) || 'workflow'
        const file = path.join(opts.workflowsDir, `${workflowSlug}-${Date.now()}.cwc`)
        const tmpFile = `${file}.${process.pid}.tmp`
        await fs.mkdir(opts.workflowsDir, { recursive: true })
        throwIfCancelled(controller.signal)
        tempWorkflowFile = tmpFile
        await fs.writeFile(tmpFile, JSON.stringify(cwc, null, 2))
        throwIfCancelled(controller.signal)
        await fs.rename(tmpFile, file)
        tempWorkflowFile = null
        finalWorkflowFile = file
        throwIfCancelled(controller.signal)
        opts.store.appendLog({ level: 'info', message: `Generated workflow "${cwc.meta.name}" in ${Math.round((Date.now() - startedAtMs) / 1000)}s` })
        await opts.store.setStatus(a.id, 'promoted')
        await opts.store.setGeneration({ id: a.id, step: 'complete', startedAt, workflowId: cwc.meta.id })
      } catch (err) {
        if (tempWorkflowFile) await fs.rm(tempWorkflowFile, { force: true }).catch(() => undefined)
        if (finalWorkflowFile) await fs.rm(finalWorkflowFile, { force: true }).catch(() => undefined)
        if (controller.signal.aborted || (err instanceof Error && /cancelled/i.test(err.message))) {
          await markPromotionCancelled(a.id)
          return
        }
        const message = err instanceof Error ? err.message : 'promote failed'
        opts.store.appendLog({ level: 'error', message: `Workflow generation failed: ${message}` })
        await opts.store.setStatus(a.id, 'promotion_failed', message)
        await opts.store.setGeneration({ id: a.id, step: 'failed', startedAt, error: message })
      } finally {
        if (activePromotion?.id === a.id && activePromotion.controller === controller) activePromotion = null
      }
    })().catch(err => {
      opts.store.appendLog({ level: 'error', message: `Workflow generation failed after response ended: ${err instanceof Error ? err.message : String(err)}` })
    })
    opts.store.trackPromotion(job)
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
