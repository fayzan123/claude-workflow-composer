import { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { DetectedAutomation, RuleApplication, RuleTarget } from '../../detection/types.js'
import type { ScanStore } from '../scan-store.js'
import { addRuleToFile, removeRuleFromFile } from '../rule-files.js'
import type { AutomationActivity } from '../automation-activity.js'
import { classifyAutomation } from '../../generation/classifier.js'

export interface AutomationRulesRouterOptions {
  homeDir: string
  store: ScanStore
  activity: AutomationActivity
}

interface RuleTargetBody {
  target?: {
    type?: unknown
    projectDir?: unknown
  }
}

interface ResolvedRuleTarget {
  target: RuleTarget
  filePath: string
}

function sameTarget(left: RuleTarget, right: RuleTarget): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'user-claude' || right.type === 'user-claude') return true
  return path.resolve(left.projectDir) === path.resolve(right.projectDir)
}

export function resolveAutomationRuleTarget(
  automation: DetectedAutomation,
  body: RuleTargetBody,
  homeDir: string,
): ResolvedRuleTarget {
  const requested = body.target
  if (requested?.type === 'user-claude') {
    return {
      target: { type: 'user-claude' },
      filePath: path.join(homeDir, '.claude', 'CLAUDE.md'),
    }
  }

  if (requested?.type !== 'project-agents') throw new Error('rule target must be user-claude or project-agents')
  const evidenceRepos = automation.evidence.repos
    .filter(repo => typeof repo === 'string' && path.isAbsolute(repo))
    .map(repo => path.resolve(repo))
  const requestedDir = typeof requested.projectDir === 'string' && requested.projectDir.trim()
    ? path.resolve(requested.projectDir.trim())
    : evidenceRepos.length === 1 ? evidenceRepos[0] : ''
  if (!requestedDir || !path.isAbsolute(requestedDir)) throw new Error('an absolute projectDir is required')
  if (!evidenceRepos.includes(requestedDir)) throw new Error('projectDir must be one of this automation\'s evidence repositories')
  return {
    target: { type: 'project-agents', projectDir: requestedDir },
    filePath: path.join(requestedDir, 'AGENTS.md'),
  }
}

async function assertProjectExists(target: RuleTarget): Promise<void> {
  if (target.type !== 'project-agents') return
  const stat = await fs.stat(target.projectDir).catch(() => null)
  if (!stat?.isDirectory()) throw new Error('the selected evidence repository is no longer available')
}

export function automationRulesRouter(opts: AutomationRulesRouterOptions): Router {
  const router = Router()

  router.post('/:id/rule', async (req, res) => {
    const automation = opts.store.getLatest()?.automations.find(candidate => candidate.id === req.params.id)
    if (!automation) return void res.status(404).json({ error: 'not found' })
    if (automation.status === 'dismissed') return void res.status(409).json({ error: 'Restore this automation before adding its rule.' })
    if (opts.store.isRunning() || opts.store.hasActivePromotion()) {
      return void res.status(409).json({ error: 'Wait for the active scan or generation to finish.' })
    }
    const releaseActivity = opts.activity.tryAcquire('rule')
    if (!releaseActivity) return void res.status(409).json({ error: 'Wait for the active scan, generation, or rule change to finish.' })

    try {
      const resolved = resolveAutomationRuleTarget(automation, req.body as RuleTargetBody, opts.homeDir)
      await assertProjectExists(resolved.target)
      const recommendedTier = classifyAutomation(automation)
      // Steps and titles come from the analysis model. A standing rule must instead
      // use the observed-prompt suggestion derived by the scan pipeline; older scan
      // records without that evidence need a rescan rather than an invented fallback.
      const suggestion = automation.ruleSuggestion?.trim()
      if (!suggestion) throw new Error('This detection has no evidence-grounded rule suggestion. Run a new history scan and try again.')
      const existing = automation.ruleApplications ?? []
      const applications: RuleApplication[] = existing.some(application => sameTarget(application.target, resolved.target))
        ? existing
        : [...existing, { target: resolved.target, appliedAt: new Date().toISOString() }]
      const previous = {
        recommendedTier: automation.recommendedTier,
        selectedTier: automation.selectedTier,
        generatedArtifactTier: automation.generatedArtifactTier,
        ruleApplications: automation.ruleApplications,
        status: automation.status,
        statusDetail: automation.statusDetail,
      }
      // Persist recovery authority before touching the guidance file. A process
      // crash may leave a visible application whose block is absent (Remove rule
      // clears that idempotently); it must never leave an untracked block with no
      // UI path to remove it.
      const pending = await opts.store.updateAutomation(automation.id, {
        recommendedTier,
        selectedTier: 'rule',
        ...(automation.generatedArtifactId && !automation.generatedArtifactTier
          ? { generatedArtifactTier: automation.selectedTier && automation.selectedTier !== 'rule' ? automation.selectedTier : 'workflow' }
          : {}),
        ruleApplications: applications,
        status: 'promoted',
        statusDetail: 'Rule application is being written to the selected guidance file.',
      })
      if (!pending) throw new Error('Automation disappeared before the rule could be applied.')

      let change: Awaited<ReturnType<typeof addRuleToFile>>
      try {
        change = await addRuleToFile(resolved.filePath, automation.id, suggestion)
      } catch (err) {
        // A normal write failure can restore the prior UI state. If that recovery
        // persist also fails, the already-persisted target remains manageable.
        await opts.store.updateAutomation(automation.id, previous).catch(() => undefined)
        throw err
      }
      const updated = await opts.store.updateAutomation(automation.id, {
        statusDetail: `${change === 'already-present'
          ? 'Rule was already present in the selected guidance file.'
          : 'Rule added to the selected guidance file.'}${recommendedTier === 'rule'
          ? ''
          : ` Added as Rule instead of the recommended ${recommendedTier[0].toUpperCase()}${recommendedTier.slice(1)}.`}`,
      })
      res.json({ ok: true, change, automation: updated, filePath: resolved.filePath })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not add the rule.'
      const conflict = /marker|symbolic-link|regular file|changed while/i.test(message)
      res.status(conflict ? 409 : 400).json({ error: message })
    } finally {
      releaseActivity()
    }
  })

  router.post('/:id/rule/remove', async (req, res) => {
    const automation = opts.store.getLatest()?.automations.find(candidate => candidate.id === req.params.id)
    if (!automation) return void res.status(404).json({ error: 'not found' })
    if (opts.store.isRunning() || opts.store.hasActivePromotion()) {
      return void res.status(409).json({ error: 'Wait for the active scan or generation to finish.' })
    }
    const releaseActivity = opts.activity.tryAcquire('rule')
    if (!releaseActivity) return void res.status(409).json({ error: 'Wait for the active scan, generation, or rule change to finish.' })

    try {
      const resolved = resolveAutomationRuleTarget(automation, req.body as RuleTargetBody, opts.homeDir)
      const change = await removeRuleFromFile(resolved.filePath, automation.id)
      const applications = (automation.ruleApplications ?? [])
        .filter(application => !sameTarget(application.target, resolved.target))
      const stillPromoted = applications.length > 0 || Boolean(automation.generatedArtifactId)
      const updated = await opts.store.updateAutomation(automation.id, {
        ruleApplications: applications,
        status: stillPromoted ? 'promoted' : 'new',
        statusDetail: stillPromoted
          ? 'Rule removed from the selected guidance file.'
          : undefined,
      })
      res.json({ ok: true, change, automation: updated, filePath: resolved.filePath })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove the rule.'
      const conflict = /marker|symbolic-link|regular file|changed while/i.test(message)
      res.status(conflict ? 409 : 400).json({ error: message })
    } finally {
      releaseActivity()
    }
  })

  return router
}
