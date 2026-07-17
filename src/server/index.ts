import express from 'express'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { healthRouter } from './api/health.js'
import { claudeCheckRouter } from './api/claude-check.js'
import { createWorkflowMutationCoordinator, workflowsRouter } from './api/workflows.js'
import { agentsRouter } from './api/agents.js'
import { recentsRouter } from './api/recents.js'
import { exportRouter } from './api/export.js'
import { exportPreviewRouter } from './api/export-preview.js'
import { deleteExport, exportDeleteRouter } from './api/export-delete.js'
import { skillsRouter } from './api/skills.js'
import { skillsGenerateRouter } from './api/skills-generate.js'
import { fileContentRouter } from './api/file-content.js'
import { openFileRouter } from './api/open-file.js'
import { exportedWorkflowsRouter } from './api/exported-workflows.js'
import type { ClaudeRunner } from './claude-runner.js'
import type { StreamingRunner } from './streaming-analyzer.js'
import { agentsGenerateRouter } from './api/agents-generate.js'
import { runsRouter } from './api/runs.js'
import { createRunStore } from './run-store.js'
import { createRunManifestStore, type RunManifestStore } from './run-manifest.js'
import { triggersRouter } from './api/triggers.js'
import { automationsRouter } from './api/automations.js'
import { createAutomationState } from './automation-state.js'
import { createScheduler } from './automation-scheduler.js'
import { startNotifier } from './notifier.js'
import { loadConfig } from './config.js'
import { sweepOrphanWorktrees, fireWorkflow, type FireOutcome } from './run-launcher.js'
import { launchTriggerTargets } from './trigger-targets.js'
import type { RunStore } from './run-store.js'
import type { CwcTrigger } from '../schema.js'
import { serviceRouter } from './api/service.js'
import { automationScanRouter } from './api/automation-scan.js'
import { automationRulesRouter } from './api/automation-rules.js'
import { createAutomationActivity } from './automation-activity.js'
import { createScanStore, type ScanStore } from './scan-store.js'
import type { ClaudeProbe } from '../detection/scan-diagnostics.js'
import { installUiTokenCookie, requireApiToken, resolveAuthToken, restrictCors } from './security.js'

export interface AppOptions {
  staticDir: string | null
  workflowsDir?: string
  userHomeDir?: string
  recentsPath?: string
  claudeRunner?: ClaudeRunner
  runsDir?: string
  claudeBinPath?: string
  worktreesRoot?: string
  automationStatePath?: string    // default ~/.cwc/automation-state.json
  configPath?: string             // default ~/.cwc/config.json
  automationScanPath?: string     // default ~/.cwc/automation-scan.json
  streamingRunner?: StreamingRunner
  enableScheduler?: boolean       // default false; bin/cwc start passes true
  enableNotifier?: boolean        // default true; tests pass false
  authToken?: string              // set by the packaged server; tests/dev injections may omit
  allowedOrigins?: string[]       // CORS allowlist for explicit cross-origin dev clients
  claudeProbe?: ClaudeProbe       // injectable `claude --version` probe for scan diagnostics
  cwcVersion?: string             // reported in scan diagnostics; default read from package.json
  runStore?: RunStore             // test injection; default is a filesystem-backed store under runsDir
  runManifestStore?: RunManifestStore // test injection; default is a filesystem-backed store under runsDir
  scanStore?: ScanStore         // test injection; default is the filesystem-backed automation scan store
}

/** Best-effort package version for diagnostics; works from both src/ (tsx) and dist/ layouts. */
function resolveCwcVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function createApp(opts: AppOptions): express.Express {
  const app = express()
  // Auth off ⇒ local dev (CWC_DISABLE_AUTH): tolerate loopback origins so the Vite dev
  // server works. Packaged mode (auth on) stays strict same-origin.
  app.use(restrictCors(opts.allowedOrigins, { allowLoopback: !opts.authToken }))
  if (opts.authToken) {
    app.use(installUiTokenCookie(opts.authToken))
    app.use(requireApiToken(opts.authToken))
  }
  app.use(express.json({ limit: '10mb' }))

  app.use('/api/health', healthRouter())
  app.use('/api/claude-check', claudeCheckRouter())

  const wfDir = opts.workflowsDir ?? path.join(os.homedir(), '.cwc', 'workflows')
  const recPath = opts.recentsPath ?? path.join(os.homedir(), '.cwc', 'recents.json')
  const workflowMutations = createWorkflowMutationCoordinator(wfDir)
  let scheduler: ReturnType<typeof createScheduler> | null = null
  const onWorkflowSaved = async () => {
    if (scheduler) await scheduler.rescan().catch(() => undefined)
  }

  const homeDir = opts.userHomeDir ?? os.homedir()
  app.use('/api/service-status', serviceRouter(homeDir))
  app.use('/api/agents/generate', agentsGenerateRouter(opts.claudeRunner))
  app.use('/api/agents', agentsRouter(homeDir))

  app.use('/api/recents', recentsRouter(recPath))

  app.use('/api/export/preview', exportPreviewRouter())
  app.use('/api/export/delete', exportDeleteRouter({ mutations: workflowMutations, onSaved: onWorkflowSaved }))
  app.use('/api/export', exportRouter({ mutations: workflowMutations, onSaved: onWorkflowSaved }))
  app.use('/api/skills/generate', skillsGenerateRouter(opts.claudeRunner))
  app.use('/api/skills', skillsRouter(homeDir))
  app.use('/api/file-content', fileContentRouter(homeDir))
  app.use('/api/open-file', openFileRouter())
  app.use('/api/exported-workflows', exportedWorkflowsRouter(homeDir))

  const runsDir = opts.runsDir ?? path.join(os.homedir(), '.cwc', 'runs')
  const worktreesRoot = opts.worktreesRoot ?? path.join(os.homedir(), '.cwc', 'worktrees')
  const skillsDir = path.join(homeDir, '.claude', 'skills')
  const statePath = opts.automationStatePath ?? path.join(os.homedir(), '.cwc', 'automation-state.json')
  const configPath = opts.configPath ?? path.join(os.homedir(), '.cwc', 'config.json')

  const manifestStore = opts.runManifestStore ?? opts.runStore?.manifests ?? createRunManifestStore(runsDir)
  const runStore = opts.runStore ?? createRunStore(runsDir, manifestStore)
  const autoState = createAutomationState(statePath)

  const scanPath = opts.automationScanPath ?? path.join(os.homedir(), '.cwc', 'automation-scan.json')
  const scanStore = opts.scanStore ?? createScanStore(scanPath)
  const automationActivity = createAutomationActivity()
  app.locals['scanStore'] = scanStore   // exposed so graceful shutdown / tests can await in-flight promotion jobs
  app.use('/api/automation-scan', automationRulesRouter({ homeDir, store: scanStore, activity: automationActivity }))
  app.use('/api/automation-scan', automationScanRouter({ homeDir, workflowsDir: wfDir, store: scanStore, activity: automationActivity, runner: opts.claudeRunner, streamingRunner: opts.streamingRunner, claudeProbe: opts.claudeProbe, cwcVersion: opts.cwcVersion ?? resolveCwcVersion() }))

  // Sweep orphan worktrees on real server start only (paused/running runs keep theirs).
  // Gated on enableScheduler so test apps with default paths never touch ~/.cwc/worktrees.
  if (opts.enableScheduler) void sweepOrphanWorktrees(runStore, runsDir, worktreesRoot, manifestStore)

  const isWorkflowBusy = async (workflowId: string, triggerId: string) => {
    if (runStore.hasActiveTestRun(workflowId)) return 'running' as const
    const runs = await runStore.listRuns(workflowId, manifestStore)
    if (runs.some(r => r.status === 'paused' && r.trigger === triggerId)) return 'paused-same-trigger' as const
    return false as const
  }

  app.use('/api/runs', runsRouter({ store: runStore, manifests: manifestStore, claudeBinPath: opts.claudeBinPath, worktreesRoot, runsDirPath: runsDir, skillsDir }))
  app.use('/api/triggers', triggersRouter({ workflowsDir: wfDir, state: autoState, store: runStore, manifests: manifestStore, worktreesRoot, skillsDir, claudeBinPath: opts.claudeBinPath, isWorkflowBusy }))

  let config = loadConfig(configPath)
  app.use('/api/automations', automationsRouter({ state: autoState, configPath, workflowsDir: wfDir, onConfigChanged: (c) => { config = c } }))
  if (opts.enableNotifier !== false) startNotifier({ store: runStore, getConfig: () => config })

  if (opts.enableScheduler) {
    scheduler = createScheduler({
      workflowsDir: wfDir, state: autoState, isWorkflowBusy,
      fire: makeSchedulerFire({
        store: runStore, manifests: manifestStore, worktreesRoot, skillsDir, claudeBinPath: opts.claudeBinPath,
        onSkip: (id, reason) => autoState.recordSkip(id, reason, new Date()),
      }),
    })
    scheduler.start()
  }
  // Await scheduler reconciliation so a deleted recipe cannot release its run
  // reservation while a stale trigger remains fireable. Rescan failure is
  // intentionally best-effort because the recipe write has already committed.
  app.use('/api/workflows', workflowsRouter(
    wfDir,
    recPath,
    onWorkflowSaved,
    async workflowId => {
      const reservationId = randomUUID()
      if (!runStore.reserveWorkflow(workflowId, reservationId)) {
        return { reason: 'Stop the active run before deleting this workflow.', release() {} }
      }
      const release = () => runStore.releaseWorkflowReservation(workflowId, reservationId)
      try {
        // Manifests are the durable authority after restart; JSONL may be absent or
        // corrupt and cannot be the only thing protecting a resumable/in-flight run.
        const authoritativeRuns = await manifestStore.listWorkflow(workflowId)
        if (authoritativeRuns.some(run => run.lifecycleState === 'paused')) {
          return { reason: 'Approve or reject the paused run before deleting this workflow.', release }
        }
        const unsettledStates = new Set([
          'claimed',
          'checking_precondition',
          'preparing',
          'worktree_created',
          'running_setup',
          'spawning',
          'running',
          'resuming',
          'checkpointing',
          'cleaning',
          'rejecting',
        ])
        if (authoritativeRuns.some(run => unsettledStates.has(run.lifecycleState))) {
          return { reason: 'Wait for the managed run to finish before deleting this workflow.', release }
        }
        const runs = await runStore.listRuns(workflowId)
        if (runs.some(run => run.source === 'test' && run.status === 'running')) {
          return { reason: 'Wait for the managed run to finish before deleting this workflow.', release }
        }
        if (runs.some(run => run.source === 'test' && run.status === 'paused')) {
          return { reason: 'Approve or reject the paused run before deleting this workflow.', release }
        }
        return { reason: null, release }
      } catch (err) {
        release()
        throw err
      }
    },
    workflow => deleteExport(workflow, { type: 'user', userDir: homeDir }),
    workflowMutations,
  ))

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir))
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(opts.staticDir!, 'index.html'))
    })
  }

  return app
}

export interface SchedulerFireDeps {
  store: RunStore
  manifests?: RunManifestStore
  worktreesRoot: string
  skillsDir?: string
  claudeBinPath?: string
  onSkip: (triggerId: string, reason: string) => Promise<void>
  fireOne?: (cwd: string, args: { workflowId: string; workflowSlug: string; trigger: CwcTrigger; launchGroupId: string }) => Promise<FireOutcome>
}

export function makeSchedulerFire(deps: SchedulerFireDeps) {
  const fireOne = deps.fireOne ?? ((cwd, a) =>
    fireWorkflow({
      workflowId: a.workflowId, workflowSlug: a.workflowSlug, cwd, isolation: a.trigger.isolation,
      baseRef: a.trigger.baseRef, precondition: a.trigger.precondition, setupCommand: a.trigger.setupCommand,
      trigger: a.trigger.id, store: deps.store, manifests: deps.manifests ?? deps.store.manifests, worktreesRoot: deps.worktreesRoot, skillsDir: deps.skillsDir, binPath: deps.claudeBinPath, launchGroupId: a.launchGroupId,
    }))
  return async (workflowId: string, workflowSlug: string, t: CwcTrigger): Promise<void> => {
    const launchGroupId = randomUUID()
    const launched = await launchTriggerTargets(t, cwd => fireOne(cwd, { workflowId, workflowSlug, trigger: t, launchGroupId }))
    await Promise.all(launched.map(({ outcome }) =>
      outcome.fired === false ? deps.onSkip(t.id, outcome.reason) : outcome.settled))
  }
}

export function startServer(port: number, staticDir: string | null): Promise<void> {
  const authToken = resolveAuthToken()
  if (!authToken) {
    console.warn('⚠️  CWC_DISABLE_AUTH=1 — API auth is OFF. Local development only; never use for the packaged app.')
  }
  const app = createApp({ staticDir, enableScheduler: true, authToken })
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`CWC server running on http://localhost:${port}`)
      resolve()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Run 'npx claude-cwc stop' to kill the existing server.`)
      }
      reject(err)
    })
  })
}
