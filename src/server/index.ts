import express from 'express'
import cors from 'cors'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { healthRouter } from './api/health.js'
import { claudeCheckRouter } from './api/claude-check.js'
import { workflowsRouter } from './api/workflows.js'
import { agentsRouter } from './api/agents.js'
import { recentsRouter } from './api/recents.js'
import { exportRouter } from './api/export.js'
import { exportPreviewRouter } from './api/export-preview.js'
import { exportDeleteRouter } from './api/export-delete.js'
import { skillsRouter } from './api/skills.js'
import { skillsGenerateRouter } from './api/skills-generate.js'
import { fileContentRouter } from './api/file-content.js'
import { openFileRouter } from './api/open-file.js'
import { exportedWorkflowsRouter } from './api/exported-workflows.js'
import type { ClaudeRunner } from './claude-runner.js'
import { agentsGenerateRouter } from './api/agents-generate.js'
import { runsRouter } from './api/runs.js'
import { createRunStore } from './run-store.js'
import { triggersRouter } from './api/triggers.js'
import { automationsRouter } from './api/automations.js'
import { createAutomationState } from './automation-state.js'
import { createScheduler } from './automation-scheduler.js'
import { startNotifier } from './notifier.js'
import { loadConfig } from './config.js'
import { sweepOrphanWorktrees, fireWorkflow, type FireOutcome } from './run-launcher.js'
import { resolveTargets } from './trigger-targets.js'
import type { RunStore } from './run-store.js'
import type { CwcTrigger } from '../schema.js'
import { serviceRouter } from './api/service.js'
import { automationCandidatesRouter } from './api/automation-candidates.js'

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
  enableScheduler?: boolean       // default false; bin/cwc start passes true
  enableNotifier?: boolean        // default true; tests pass false
}

export function createApp(opts: AppOptions): express.Express {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  app.use('/api/health', healthRouter())
  app.use('/api/claude-check', claudeCheckRouter())

  const wfDir = opts.workflowsDir ?? path.join(os.homedir(), '.cwc', 'workflows')
  const recPath = opts.recentsPath ?? path.join(os.homedir(), '.cwc', 'recents.json')

  const homeDir = opts.userHomeDir ?? os.homedir()
  app.use('/api/service-status', serviceRouter(homeDir))
  app.use('/api/automation-candidates', automationCandidatesRouter(homeDir))
  app.use('/api/agents/generate', agentsGenerateRouter(opts.claudeRunner))
  app.use('/api/agents', agentsRouter(homeDir))

  app.use('/api/recents', recentsRouter(recPath))

  app.use('/api/export/preview', exportPreviewRouter())
  app.use('/api/export/delete', exportDeleteRouter())
  app.use('/api/export', exportRouter())
  app.use('/api/skills/generate', skillsGenerateRouter(opts.claudeRunner))
  app.use('/api/skills', skillsRouter(homeDir))
  app.use('/api/file-content', fileContentRouter(homeDir))
  app.use('/api/open-file', openFileRouter())
  app.use('/api/exported-workflows', exportedWorkflowsRouter(homeDir))

  const runsDir = opts.runsDir ?? path.join(os.homedir(), '.cwc', 'runs')
  const worktreesRoot = opts.worktreesRoot ?? path.join(os.homedir(), '.cwc', 'worktrees')
  const statePath = opts.automationStatePath ?? path.join(os.homedir(), '.cwc', 'automation-state.json')
  const configPath = opts.configPath ?? path.join(os.homedir(), '.cwc', 'config.json')

  const runStore = createRunStore(runsDir)
  const autoState = createAutomationState(statePath)

  // Sweep orphan worktrees on real server start only (paused/running runs keep theirs).
  // Gated on enableScheduler so test apps with default paths never touch ~/.cwc/worktrees.
  if (opts.enableScheduler) void sweepOrphanWorktrees(runStore, runsDir, worktreesRoot)

  const isWorkflowBusy = async (workflowId: string, triggerId: string) => {
    if (runStore.hasActiveTestRun(workflowId)) return 'running' as const
    const runs = await runStore.listRuns(workflowId)
    if (runs.some(r => r.status === 'paused' && r.trigger === triggerId)) return 'paused-same-trigger' as const
    return false as const
  }

  app.use('/api/runs', runsRouter({ store: runStore, claudeBinPath: opts.claudeBinPath, worktreesRoot, runsDirPath: runsDir, skillsDir: path.join(homeDir, '.claude', 'skills') }))
  app.use('/api/triggers', triggersRouter({ workflowsDir: wfDir, state: autoState, store: runStore, worktreesRoot, claudeBinPath: opts.claudeBinPath, isWorkflowBusy }))

  let config = loadConfig(configPath)
  app.use('/api/automations', automationsRouter({ state: autoState, configPath, workflowsDir: wfDir, onConfigChanged: (c) => { config = c } }))
  if (opts.enableNotifier !== false) startNotifier({ store: runStore, getConfig: () => config })

  let scheduler: ReturnType<typeof createScheduler> | null = null
  if (opts.enableScheduler) {
    scheduler = createScheduler({
      workflowsDir: wfDir, state: autoState, isWorkflowBusy,
      fire: makeSchedulerFire({
        store: runStore, worktreesRoot, claudeBinPath: opts.claudeBinPath,
        onSkip: (id, reason) => autoState.recordSkip(id, reason, new Date()),
      }),
    })
    scheduler.start()
  }
  // workflowsRouter call gains the third arg for scheduler rescan on save
  app.use('/api/workflows', workflowsRouter(wfDir, recPath, () => { void scheduler?.rescan() }))

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
  worktreesRoot: string
  claudeBinPath?: string
  onSkip: (triggerId: string, reason: string) => Promise<void>
  fireOne?: (cwd: string, args: { workflowId: string; workflowSlug: string; trigger: CwcTrigger }) => Promise<FireOutcome>
}

export function makeSchedulerFire(deps: SchedulerFireDeps) {
  const fireOne = deps.fireOne ?? ((cwd, a) =>
    fireWorkflow({
      workflowId: a.workflowId, workflowSlug: a.workflowSlug, cwd, isolation: a.trigger.isolation,
      baseRef: a.trigger.baseRef, precondition: a.trigger.precondition, setupCommand: a.trigger.setupCommand,
      trigger: a.trigger.id, store: deps.store, worktreesRoot: deps.worktreesRoot, binPath: deps.claudeBinPath,
    }))
  return async (workflowId: string, workflowSlug: string, t: CwcTrigger): Promise<void> => {
    const outcomes = await Promise.all(resolveTargets(t).map(cwd => fireOne(cwd, { workflowId, workflowSlug, trigger: t })))
    await Promise.all(outcomes.map(o =>
      o.fired === false ? deps.onSkip(t.id, o.reason) : o.settled))
  }
}

export function startServer(port: number, staticDir: string | null): Promise<void> {
  const app = createApp({ staticDir, enableScheduler: true })
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`CWC server running on http://localhost:${port}`)
      resolve()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Run 'cwc stop' to kill the existing server.`)
      }
      reject(err)
    })
  })
}
