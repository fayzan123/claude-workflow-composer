// src/server/api/triggers.ts
import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CwcFile, CwcTrigger } from '../../schema.js'
import { slugify } from '../../slugify.js'
import type { AutomationState } from '../automation-state.js'
import { fireWorkflow } from '../run-launcher.js'
import type { RunStore } from '../run-store.js'

export interface TriggersRouterOptions {
  workflowsDir: string
  state: AutomationState
  store: RunStore
  worktreesRoot: string
  claudeBinPath?: string
  isWorkflowBusy: (workflowId: string, triggerId: string) => Promise<'running' | 'paused-same-trigger' | false>
}

const PAYLOAD_LIMIT = 8 * 1024

export function triggersRouter(opts: TriggersRouterOptions): Router {
  const router = Router()

  async function findByToken(token: string): Promise<{ cwc: CwcFile; trigger: CwcTrigger } | null> {
    let files: string[] = []
    try { files = (await fs.readdir(opts.workflowsDir)).filter(f => f.endsWith('.cwc')) } catch { return null }
    for (const f of files) {
      try {
        const cwc = JSON.parse(await fs.readFile(path.join(opts.workflowsDir, f), 'utf-8')) as CwcFile
        const trigger = (cwc.meta.triggers ?? []).find(t => t.type === 'webhook' && t.token === token)
        if (trigger) return { cwc, trigger }
      } catch { /* skip unreadable */ }
    }
    return null
  }

  router.post('/:token', async (req, res) => {
    const found = await findByToken(req.params.token)
    if (!found) return void res.status(404).json({ error: 'unknown trigger token' })
    const { cwc, trigger } = found
    const nowD = new Date()
    if (!trigger.enabled) return void res.status(423).json({ error: 'trigger disabled' })
    if (!opts.state.isArmed(trigger)) return void res.status(423).json({ error: 'trigger not armed — activate it in CWC' })
    if (opts.state.isPaused()) {
      await opts.state.recordSkip(trigger.id, 'automations paused', nowD)
      return void res.status(423).json({ error: 'automations are paused' })
    }
    if (!opts.state.canFire(trigger, nowD)) {
      await opts.state.recordSkip(trigger.id, 'daily cap', nowD)
      return void res.status(423).json({ error: 'daily cap reached' })
    }
    const busy = await opts.isWorkflowBusy(cwc.meta.id, trigger.id)
    if (busy) {
      await opts.state.recordSkip(trigger.id, busy === 'running' ? 'running' : 'paused run awaiting review', nowD)
      return void res.status(409).json({ error: 'workflow has an active or unreviewed run' })
    }

    let payload: string | undefined
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      let json = JSON.stringify(req.body, null, 2)
      if (json.length > PAYLOAD_LIMIT) json = json.slice(0, PAYLOAD_LIMIT) + '\n…[truncated]'
      payload = json
    }

    await opts.state.recordFire(trigger.id, nowD)
    const outcome = await fireWorkflow({
      workflowId: cwc.meta.id, workflowSlug: 'cwc-' + slugify(cwc.meta.name),
      cwd: trigger.cwd, isolation: trigger.isolation, baseRef: trigger.baseRef,
      precondition: trigger.precondition, setupCommand: trigger.setupCommand,
      trigger: trigger.id, payload, store: opts.store, worktreesRoot: opts.worktreesRoot, binPath: opts.claudeBinPath,
    })
    if (outcome.fired === false) {
      await opts.state.recordSkip(trigger.id, outcome.reason, nowD)
      return void res.status(409).json({ error: `skipped: ${outcome.reason}` })
    }
    res.status(202).json({ runId: outcome.runId })
  })

  return router
}
