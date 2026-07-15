// src/server/api/triggers.ts
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CwcFile, CwcTrigger } from '../../schema.js'
import { workflowSkillSlug } from '../../slugify.js'
import type { AutomationState } from '../automation-state.js'
import { fireWorkflow } from '../run-launcher.js'
import type { RunStore } from '../run-store.js'
import { launchTriggerTargets } from '../trigger-targets.js'

export interface TriggersRouterOptions {
  workflowsDir: string
  state: AutomationState
  store: RunStore
  worktreesRoot: string
  skillsDir: string
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
    const workflowSlug = cwc.meta.exportedWorkflowSlug ?? workflowSkillSlug(cwc.meta.name)
    const launchGroupId = randomUUID()
    const launched = await launchTriggerTargets(trigger, cwd => fireWorkflow({
      workflowId: cwc.meta.id, workflowSlug,
      cwd, isolation: trigger.isolation, baseRef: trigger.baseRef,
      precondition: trigger.precondition, setupCommand: trigger.setupCommand,
      trigger: trigger.id, payload, store: opts.store, worktreesRoot: opts.worktreesRoot, skillsDir: opts.skillsDir, binPath: opts.claudeBinPath, launchGroupId,
    }))
    const runs = launched.flatMap(({ cwd, outcome }) => outcome.fired ? [{ cwd, runId: outcome.runId }] : [])
    const skipped = launched.flatMap(({ cwd, outcome }) => outcome.fired ? [] : [{ cwd, reason: outcome.reason }])
    await Promise.all(skipped.map(item => opts.state.recordSkip(trigger.id, item.reason, nowD)))
    if (runs.length === 0) {
      const reason = skipped.map(item => `${item.cwd}: ${item.reason}`).join('; ') || 'no target directories configured'
      return void res.status(409).json({ error: `skipped: ${reason}`, skipped })
    }
    res.status(202).json({ runId: runs[0].runId, runs, skipped })
  })

  return router
}
