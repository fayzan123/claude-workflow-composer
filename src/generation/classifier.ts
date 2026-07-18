import type { ArtifactTier, AutomationShape, DetectedAutomation } from '../detection/types.js'
import { validatedIndependentStepIndexes } from '../detection/automation-shape.js'
import { ARCHETYPE_IDS } from './archetypes.js'

const KNOWN_ARCHETYPES = new Set(ARCHETYPE_IDS)
const SLASH_COMMAND_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/

function validShape(value: AutomationShape | undefined, stepCount: number): value is AutomationShape {
  if (!value) return false
  if (!Array.isArray(value.stepArchetypes) || value.stepArchetypes.length !== stepCount) return false
  if (!value.stepArchetypes.every(id => typeof id === 'string' && KNOWN_ARCHETYPES.has(id))) return false
  const distinct = new Set(value.stepArchetypes.filter(id => id !== 'generic')).size
  if (!Number.isInteger(value.distinctArchetypes) || value.distinctArchetypes !== distinct) return false
  if (!Number.isInteger(value.independentStepGroups) || value.independentStepGroups < 1) return false
  if (value.independentStepGroups > Math.max(1, stepCount)) return false
  if (validatedIndependentStepIndexes(value, stepCount) === null) return false
  if (typeof value.hasToolActivity !== 'boolean'
    || typeof value.hasVerifySignal !== 'boolean'
    || typeof value.hasRetryPattern !== 'boolean'
    || typeof value.hasRiskyStep !== 'boolean'
    || typeof value.recurring !== 'boolean') return false
  if (value.hasHardRiskyStep !== undefined) {
    if (typeof value.hasHardRiskyStep !== 'boolean') return false
    if (value.hasHardRiskyStep && !value.hasRiskyStep) return false
  }
  if (value.invokedSlashCommand !== undefined
    && (typeof value.invokedSlashCommand !== 'string' || !SLASH_COMMAND_RE.test(value.invokedSlashCommand))) return false
  if (value.observedVerifyCommand !== undefined
    && (typeof value.observedVerifyCommand !== 'string' || value.observedVerifyCommand.trim() === '')) return false
  if (value.observedMutatingTools !== undefined) {
    if (!Array.isArray(value.observedMutatingTools)
      || value.observedMutatingTools.length === 0
      || value.observedMutatingTools.length > 32
      || value.observedMutatingTools.some(tool =>
        typeof tool !== 'string' || tool.length > 200 || !/^[A-Za-z0-9_.:/-]+$/.test(tool))
      || new Set(value.observedMutatingTools).size !== value.observedMutatingTools.length
      || !value.hasToolActivity
      || !value.hasRiskyStep) return false
  }
  if (value.stepArchetypes.some(id => id === 'verify') && !value.hasVerifySignal) return false
  if (value.stepArchetypes.some(id => id === 'publish' || id === 'communicate') && !value.hasRiskyStep) return false
  if (value.hasRetryPattern && !value.hasVerifySignal) return false
  if (value.observedVerifyCommand !== undefined && (!value.hasToolActivity || !value.hasVerifySignal)) return false
  return true
}

export interface TierRecommendation {
  tier: ArtifactTier
  /** One user-facing sentence naming the evidence that selected the tier. */
  reason: string
}

/** Deterministic and ordered: first match wins. Missing/malformed persisted shape
 * stays on the legacy workflow path so an upgrade never silently removes agents or gates. */
export function classifyAutomationWithReason(automation: DetectedAutomation): TierRecommendation {
  const shape = automation.shape
  if (!validShape(shape, automation.steps.length)) {
    return {
      tier: 'workflow',
      reason: 'This record predates shape analysis, so it keeps the full workflow treatment.',
    }
  }

  // The repetition is already an installed slash command. A wrapper artifact would
  // duplicate it; the right output is a standing rule pointing at the command.
  if (shape.invokedSlashCommand) {
    return {
      tier: 'rule',
      reason: `Most sightings already invoke the installed /${shape.invokedSlashCommand} command — a standing rule pointing at it beats a duplicate artifact.`,
    }
  }

  // Hard external actions (publish, deploy, external comms, destructive deletes)
  // keep the gate-capable workflow path. Soft VCS collaboration (commit/push/PR)
  // stays eligible for the smaller tiers with its observed tool names retained.
  // Legacy shapes without the hard/soft split classify conservatively as hard.
  if (shape.hasHardRiskyStep ?? shape.hasRiskyStep) {
    return {
      tier: 'workflow',
      reason: 'An irreversible external action was observed (publish, deploy, or outward communication), so it gets the workflow tier\'s read-only preflight and approval gate.',
    }
  }

  if (!shape.hasToolActivity && automation.evidence.count >= 3) {
    return {
      tier: 'rule',
      reason: 'This repeats as an instruction with no tool activity — standing guidance in CLAUDE.md/AGENTS.md covers it without any artifact to run.',
    }
  }
  if (shape.independentStepGroups >= 2) {
    return {
      tier: 'workflow',
      reason: `The evidence shows ${shape.independentStepGroups} independent step groups that ran in parallel — the canvas can fan those out to separate agents.`,
    }
  }
  // Archetype variety is deliberately NOT a workflow signal: verb diversity in a
  // linear checklist is not multi-role evidence; grounded parallelism above is.

  if (shape.recurring) {
    return {
      tier: 'loop',
      reason: 'This work recurs on a schedule, so it generates as a skill plus a timer trigger you can arm.',
    }
  }
  if (shape.hasVerifySignal && shape.hasRetryPattern) {
    return {
      tier: 'loop',
      reason: 'A verify-fix-retry cycle was observed, so the skill gets the observed check as its stop condition.',
    }
  }
  return {
    tier: 'skill',
    reason: 'A linear single-role procedure — one plain skill is the smallest artifact that runs it.',
  }
}

export function classifyAutomation(automation: DetectedAutomation): ArtifactTier {
  return classifyAutomationWithReason(automation).tier
}
