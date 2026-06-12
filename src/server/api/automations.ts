// src/server/api/automations.ts
import { Router } from 'express'
import type { AutomationState } from '../automation-state.js'
import { loadConfig, saveConfig, type CwcConfig } from '../config.js'
import type { CwcTrigger } from '../../schema.js'

export interface AutomationsRouterOptions {
  state: AutomationState
  configPath: string
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
  router.get('/config', (_req, res) => { res.json(loadConfig(opts.configPath)) })
  router.put('/config', async (req, res) => {
    const c = req.body as CwcConfig
    await saveConfig(opts.configPath, c)
    opts.onConfigChanged(c)
    res.json(c)
  })
  return router
}
