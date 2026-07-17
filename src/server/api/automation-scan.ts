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
import type { ArtifactTier, TaskUnit, DetectedAutomation } from '../../detection/types.js'
import type { ScanStore } from '../scan-store.js'
import { buildWorkflowGenPrompt, parseWorkflowJson } from '../../generation/workflow-generator.js'
import { buildCapabilityCards, listReusableAgents, listReusableSkills, selectRelevantAgents, selectRelevantSkills } from '../skill-catalog.js'
import { slugify } from '../../slugify.js'
import { CWC_FILE_VERSION, type CwcFile, type CwcTrigger } from '../../schema.js'
import { generateArtifact } from '../../generation/generate.js'
import { classifyAutomation } from '../../generation/classifier.js'
import type { AutomationActivity } from '../automation-activity.js'
import { observedVerificationStep } from '../../detection/automation-shape.js'

export interface AutomationScanRouterOptions {
  homeDir: string
  workflowsDir: string
  store: ScanStore
  activity: AutomationActivity
  runner?: ClaudeRunner
  streamingRunner?: StreamingRunner
  genModel?: string         // model for procedural artifact generation; default Sonnet
  claudeProbe?: ClaudeProbe // injectable `claude --version` probe for diagnostics
  cwcVersion?: string       // reported in the diagnostics bundle
}

/** Models the scan analysis may run on (friendly key → CLI model id). Allowlisted so a request can't pass an arbitrary --model. */
const SCAN_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
}

const ARTIFACT_TIERS: ArtifactTier[] = ['rule', 'skill', 'loop', 'workflow']

function isArtifactTier(value: unknown): value is ArtifactTier {
  return typeof value === 'string' && ARTIFACT_TIERS.includes(value as ArtifactTier)
}

function tierLabel(tier: ArtifactTier): string {
  return tier[0].toUpperCase() + tier.slice(1)
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
  let activePromotion: { id: string; tier: Exclude<ArtifactTier, 'rule'>; controller: AbortController } | null = null
  let scanStarting = false

  function hasPromotionWork(): boolean {
    return opts.store.hasActivePromotion() || activePromotion !== null
  }

  function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Artifact generation cancelled.')
  }

  async function markPromotionCancelled(id: string, tier?: Exclude<ArtifactTier, 'rule'>): Promise<void> {
    const current = opts.store.getLatest()?.automations.find(a => a.id === id)
    if (current?.status !== 'promotion_cancelled') {
      opts.store.appendLog({ level: 'info', message: 'Artifact generation cancelled' })
      await opts.store.setStatus(id, 'promotion_cancelled', 'Artifact generation was cancelled.')
    }
    const generation = opts.store.getGeneration()
    const generationTier = tier ?? generation?.tier
    await opts.store.setGeneration({
      id,
      step: 'cancelled',
      startedAt: generation?.id === id ? generation.startedAt : new Date().toISOString(),
      ...(generationTier ? { tier: generationTier } : {}),
      error: 'Artifact generation was cancelled.',
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

  async function generatePromotionArtifact(
    a: DetectedAutomation,
    tier: Exclude<ArtifactTier, 'rule'>,
    triggers: CwcTrigger[],
    controller: AbortController,
  ): Promise<{ cwc: CwcFile; fallbackUsed?: boolean }> {
    // The legacy model-authored graph format cannot express deterministic approval
    // gates. Keep the compatibility path for ordinary workflows, but never route
    // detected external mutations through a compiler that could omit their gate or
    // exact connector-tool allowlist.
    if (tier === 'workflow' && process.env['CWC_LEGACY_GEN'] === '1' && a.shape?.hasRiskyStep !== true) {
      const cwc = await generateLegacyWorkflow(a, controller)
      cwc.meta = {
        ...cwc.meta,
        version: CWC_FILE_VERSION,
        artifactKind: 'workflow',
        artifactTier: 'workflow',
        sourceAutomation: {
          id: a.id,
          steps: [...a.steps],
          ...(a.shape?.observedVerifyCommand ? { verificationCommand: a.shape.observedVerifyCommand } : {}),
          ...(observedVerificationStep(a) ? { verificationStep: observedVerificationStep(a) } : {}),
        },
        triggers,
      }
      return { cwc }
    }
    if (tier === 'workflow' && process.env['CWC_LEGACY_GEN'] === '1' && a.shape?.hasRiskyStep === true) {
      opts.store.appendLog({ level: 'info', message: 'Using the safety compiler because this workflow contains an observed external action.' })
    }
    const result = await generateArtifact({
      automation: a,
      tier,
      homeDir: opts.homeDir,
      runner,
      model: opts.genModel ?? 'claude-sonnet-4-6',
      signal: controller.signal,
      triggers,
      onLog: message => opts.store.appendLog({ level: 'info', message }),
    })
    if (!('cwc' in result)) throw new Error('Rule suggestions must be applied through the explicit rule action.')
    return result
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
    if (hasPromotionWork()) return void res.status(409).json({ error: 'An artifact generation is already running.' })
    const releaseActivity = opts.activity.tryAcquire('scan')
    if (!releaseActivity) return void res.status(409).json({ error: 'Wait for the active generation or rule change to finish.' })
    scanStarting = true
    const model = resolveScanModel((req.body ?? {}).model)
    // Gate: Detect's analysis stage spawns `claude -p`; without the binary every scan
    // dies mid-flight with an opaque ENOENT. Probe once up front (result is reused as
    // the diagnostics env snapshot) and refuse with an actionable message instead.
    const env = await envSnapshot(opts.cwcVersion ?? 'unknown', opts.claudeProbe).catch(err => {
      scanStarting = false
      releaseActivity()
      throw err
    })
    if (!env.claude.found) {
      scanStarting = false
      releaseActivity()
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
    }).catch(() => { /* store records the error */ }).finally(() => { scanStarting = false; releaseActivity() })
  })

  router.get('/diagnostics', (_req, res) => {
    const d = opts.store.getLatest()?.diagnostics
    if (!d) return void res.status(404).json({ error: 'No scan diagnostics recorded yet. Run a scan first.' })
    res.json(d)
  })

  router.post('/:id/dismiss', async (req, res) => {
    if (opts.activity.activeKind()) return void res.status(409).json({ error: 'Wait for the active scan, generation, or rule change to finish.' })
    if (hasPromotionWork()) return void res.status(409).json({ error: 'An artifact generation is already running.' })
    const current = opts.store.getLatest()?.automations.find(candidate => candidate.id === req.params.id)
    if (!current) return void res.status(404).json({ error: 'not found' })
    if ((current.ruleApplications?.length ?? 0) > 0) {
      return void res.status(409).json({ error: 'Remove every applied rule before dismissing this automation.' })
    }
    try {
      await opts.store.dismiss(current.id)
      res.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not dismiss this automation.'
      res.status(409).json({ error: message })
    }
  })

  router.post('/:id/restore', async (req, res) => {
    if (opts.activity.activeKind()) return void res.status(409).json({ error: 'Wait for the active scan, generation, or rule change to finish.' })
    if (hasPromotionWork()) return void res.status(409).json({ error: 'An artifact generation is already running.' })
    const current = opts.store.getLatest()?.automations.find(candidate => candidate.id === req.params.id)
    if (!current) return void res.status(404).json({ error: 'not found' })
    if (current.status !== 'dismissed') return void res.status(409).json({ error: 'Automation is not dismissed.' })
    const automation = await opts.store.restore(current.id)
    res.json({ ok: true, automation })
  })

  router.post('/:id/promote/cancel', async (req, res) => {
    const a = opts.store.getLatest()?.automations.find(x => x.id === req.params.id)
    if (!a) return void res.status(404).json({ error: 'not found' })
    if (a.status !== 'promoting') return void res.status(409).json({ error: 'No artifact generation is running for this automation.' })
    if (activePromotion?.id === a.id) activePromotion.controller.abort()
    await markPromotionCancelled(a.id, activePromotion?.id === a.id ? activePromotion.tier : undefined)
    res.json({ cancelled: true })
  })

  router.post('/:id/promote', async (req, res) => {
    if (opts.store.isRunning()) return void res.status(409).json({ error: 'A scan is already running.' })
    if (hasPromotionWork()) return void res.status(409).json({ error: 'An artifact generation is already running.' })
    const a = opts.store.getLatest()?.automations.find(x => x.id === req.params.id)
    if (!a) return void res.status(404).json({ error: 'not found' })
    if (a.status === 'dismissed') return void res.status(409).json({ error: 'Restore this automation before generating an artifact.' })
    const previousGeneratedArtifactId = a.generatedArtifactId
    const previousGeneratedArtifactTier = a.generatedArtifactTier
      ?? (a.generatedArtifactId && a.selectedTier && a.selectedTier !== 'rule' ? a.selectedTier : undefined)
      ?? (a.generatedArtifactId ? 'workflow' : undefined)
    const recommendedTier = classifyAutomation(a)
    const requestedTier = (req.body ?? {}).tier
    if (requestedTier !== undefined && !isArtifactTier(requestedTier)) {
      return void res.status(400).json({ error: `tier must be one of: ${ARTIFACT_TIERS.join(', ')}` })
    }
    const selectedTier = requestedTier ?? recommendedTier
    if (selectedTier === 'rule') {
      return void res.status(400).json({ error: 'Rules require an explicit target. Use the Add rule action instead.' })
    }
    const releaseActivity = opts.activity.tryAcquire('promotion')
    if (!releaseActivity) return void res.status(409).json({ error: 'Wait for the active scan, generation, or rule change to finish.' })
    const controller = new AbortController()
    activePromotion = { id: a.id, tier: selectedTier, controller }
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()

    try {
      // updateAutomation mutates the in-memory record before awaiting its queued persist. Set
      // `promoting` in that first mutation so rule/scan routes cannot slip through the await.
      await opts.store.updateAutomation(a.id, {
        recommendedTier,
        selectedTier,
        ...(a.generatedArtifactId && !a.generatedArtifactTier
          ? { generatedArtifactTier: a.selectedTier && a.selectedTier !== 'rule' ? a.selectedTier : 'workflow' }
          : {}),
        status: 'promoting',
        statusDetail: undefined,
      })
      await opts.store.setGeneration({ id: a.id, step: 'planning', startedAt, tier: selectedTier })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start artifact generation.'
      await opts.store.setStatus(a.id, 'promotion_failed', message).catch(() => undefined)
      await opts.store.setGeneration({ id: a.id, step: 'failed', startedAt, tier: selectedTier, error: message }).catch(() => undefined)
      if (activePromotion?.id === a.id && activePromotion.controller === controller) activePromotion = null
      releaseActivity()
      return void res.status(500).json({ error: message })
    }
    res.status(202).json({ status: 'generating' })

    const job = (async () => {
      let tempArtifactFile: string | null = null
      let finalArtifactFile: string | null = null
      try {
        const triggers = triggersForAutomation(a, selectedTier)
        opts.store.appendLog({ level: 'info', message: `Generating ${selectedTier} for "${a.title}"` })
        const { cwc, fallbackUsed } = await generatePromotionArtifact(a, selectedTier, triggers, controller)
        throwIfCancelled(controller.signal)

        // Overwrite the LLM-generated id with a server-assigned UUID to guarantee
        // uniqueness and safe post-promote navigation (/w/<id>/build).
        const now = new Date().toISOString()
        cwc.meta.id = randomUUID()
        cwc.meta.created = now
        cwc.meta.updated = now
        cwc.meta.version = CWC_FILE_VERSION
        cwc.meta.artifactKind = selectedTier === 'workflow' ? 'workflow' : 'skill'
        cwc.meta.artifactTier = selectedTier
        cwc.meta.sourceAutomation = {
          ...cwc.meta.sourceAutomation,
          id: a.id,
          steps: [...a.steps],
          ...(a.shape?.observedVerifyCommand ? { verificationCommand: a.shape.observedVerifyCommand } : {}),
          ...(observedVerificationStep(a) ? { verificationStep: observedVerificationStep(a) } : {}),
        }
        throwIfCancelled(controller.signal)

        await opts.store.setGeneration({ id: a.id, step: 'writing', startedAt, tier: selectedTier })
        const artifactSlug = slugify(cwc.meta.name) || selectedTier
        const file = path.join(opts.workflowsDir, `${artifactSlug}-${cwc.meta.id}.cwc`)
        const tmpFile = `${file}.${process.pid}.tmp`
        await fs.mkdir(opts.workflowsDir, { recursive: true })
        throwIfCancelled(controller.signal)
        tempArtifactFile = tmpFile
        await fs.writeFile(tmpFile, JSON.stringify(cwc, null, 2))
        throwIfCancelled(controller.signal)
        await fs.rename(tmpFile, file)
        tempArtifactFile = null
        finalArtifactFile = file
        throwIfCancelled(controller.signal)
        const fallbackNote = fallbackUsed ? ' using the deterministic checklist fallback' : ''
        opts.store.appendLog({ level: 'info', message: `Generated ${selectedTier} "${cwc.meta.name}"${fallbackNote} in ${Math.round((Date.now() - startedAtMs) / 1000)}s` })
        const statusDetail = selectedTier === recommendedTier
          ? `Generated as ${tierLabel(selectedTier)}.`
          : `Generated as ${tierLabel(selectedTier)} instead of the recommended ${tierLabel(recommendedTier)}.`
        const committed = await opts.store.commitPromotion(a.id, {
          status: 'promoted',
          statusDetail,
          generatedArtifactId: cwc.meta.id,
          generatedArtifactTier: selectedTier,
          selectedTier,
          recommendedTier,
        }, {
          id: a.id,
          step: 'complete',
          startedAt,
          tier: selectedTier,
          artifactId: cwc.meta.id,
          workflowId: cwc.meta.id,
        })
        if (!committed) throw new Error('Automation disappeared before artifact generation could be committed.')
        // The artifact and its owning scan-state snapshot are now committed together.
        // Never remove this file in later error handling.
        finalArtifactFile = null
      } catch (err) {
        if (tempArtifactFile) await fs.rm(tempArtifactFile, { force: true }).catch(() => undefined)
        if (finalArtifactFile) await fs.rm(finalArtifactFile, { force: true }).catch(() => undefined)
        if (controller.signal.aborted || (err instanceof Error && /cancelled/i.test(err.message))) {
          await markPromotionCancelled(a.id, selectedTier)
          return
        }
        const message = err instanceof Error ? err.message : 'promote failed'
        opts.store.appendLog({ level: 'error', message: `Artifact generation failed: ${message}` })
        await opts.store.updateAutomation(a.id, {
          status: 'promotion_failed',
          statusDetail: message,
          generatedArtifactId: previousGeneratedArtifactId,
          generatedArtifactTier: previousGeneratedArtifactTier,
        })
        await opts.store.setGeneration({ id: a.id, step: 'failed', startedAt, tier: selectedTier, error: message })
      } finally {
        if (activePromotion?.id === a.id && activePromotion.controller === controller) activePromotion = null
        releaseActivity()
      }
    })().catch(err => {
      opts.store.appendLog({ level: 'error', message: `Artifact generation failed after response ended: ${err instanceof Error ? err.message : String(err)}` })
    })
    opts.store.trackPromotion(job)
  })

  return router
}

/**
 * Seed triggers from the automation's detected shape. Only SCHEDULE-shaped automations get a
 * cron trigger — manual/event ones become plain on-demand workflows (no schedule shoehorned on).
 */
export function triggersForAutomation(a: DetectedAutomation, tier: 'skill' | 'loop' | 'workflow' = 'workflow'): CwcTrigger[] {
  if (tier === 'skill') return []
  const hasGroundedVerification = Boolean(a.shape?.observedVerifyCommand || observedVerificationStep(a))
  const shouldSeedSchedule = a.suggestedTrigger.kind === 'schedule'
    || (tier === 'loop' && a.shape?.recurring === true)
    // An explicit loop override must always have something that makes it a loop.
    // A persisted boolean without a retained command/step is not an executable
    // stopping contract, so give it a disabled schedule for the user to review.
    || (tier === 'loop' && !hasGroundedVerification)
  return shouldSeedSchedule ? [cronTriggerFor(a)] : []
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
