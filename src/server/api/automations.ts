// src/server/api/automations.ts
import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Cron } from 'croner'
import type { AutomationState } from '../automation-state.js'
import { loadConfig, saveConfig, type CwcConfig } from '../config.js'
import type { CwcFile, CwcTrigger } from '../../schema.js'

export interface AutomationsRouterOptions {
  state: AutomationState
  configPath: string
  workflowsDir: string
  onConfigChanged: (c: CwcConfig) => void
}

export function automationsRouter(opts: AutomationsRouterOptions): Router {
  const router = Router()
  router.get('/state', (_req, res) => { res.json({ paused: opts.state.isPaused() }) })
  router.put('/state', async (req, res) => {
    await opts.state.setPaused(Boolean((req.body ?? {}).paused))
    res.json({ paused: opts.state.isPaused() })
  })
  router.post('/arm', async (req, res) => {
    const trigger = (req.body ?? {}).trigger as CwcTrigger | undefined
    if (!trigger?.id) return void res.status(400).json({ error: 'trigger required' })
    await opts.state.arm(trigger)
    res.json({ armed: true })
  })
  router.get('/trigger-state/:id', (req, res) => { res.json(opts.state.getTriggerState(req.params.id)) })
  router.post('/trigger-status', (req, res) => {
    const trigger = (req.body ?? {}).trigger as CwcTrigger | undefined
    if (!trigger?.id) return void res.status(400).json({ error: 'trigger required' })
    res.json({ armed: opts.state.isArmed(trigger), ...opts.state.getTriggerState(trigger.id) })
  })
  router.get('/triggers', async (_req, res) => {
    let files: string[] = []
    try { files = (await fs.readdir(opts.workflowsDir)).filter(f => f.endsWith('.cwc')) } catch { /* none */ }
    const rows: unknown[] = []
    for (const f of files) {
      let cwc: CwcFile
      try { cwc = JSON.parse(await fs.readFile(path.join(opts.workflowsDir, f), 'utf-8')) } catch { continue }
      for (const t of cwc.meta.triggers ?? []) {
        if (t.type !== 'cron' || !t.schedule) continue
        const st = opts.state.getTriggerState(t.id)
        let nextFireAt: string | null = null
        try { nextFireAt = new Cron(t.schedule).nextRun()?.toISOString() ?? null } catch { /* invalid */ }
        rows.push({
          workflowId: cwc.meta.id, workflowName: cwc.meta.name, triggerId: t.id,
          schedule: t.schedule, enabled: t.enabled, armed: opts.state.isArmed(t),
          nextFireAt, lastFiredAt: st.lastFiredAt ?? null, lastSkip: st.lastSkip ?? null,
        })
      }
    }
    res.json(rows)
  })

  router.get('/config', (_req, res) => { res.json(loadConfig(opts.configPath)) })
  router.put('/config', async (req, res) => {
    const c = req.body as CwcConfig
    await saveConfig(opts.configPath, c)
    opts.onConfigChanged(c)
    res.json(c)
  })
  return router
}
