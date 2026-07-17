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

/** Deterministic and ordered: first match wins. Missing/malformed persisted shape
 * stays on the legacy workflow path so an upgrade never silently removes agents or gates. */
export function classifyAutomation(automation: DetectedAutomation): ArtifactTier {
  const shape = automation.shape
  if (!validShape(shape, automation.steps.length)) return 'workflow'

  // The repetition is already an installed slash command. A wrapper artifact would
  // duplicate it; the right output is a standing rule pointing at the command.
  if (shape.invokedSlashCommand) return 'rule'

  // Hard external actions (publish, deploy, external comms, destructive deletes)
  // keep the gate-capable workflow path. Soft VCS collaboration (commit/push/PR)
  // stays eligible for the smaller tiers with its observed tool names retained.
  // Legacy shapes without the hard/soft split classify conservatively as hard.
  if (shape.hasHardRiskyStep ?? shape.hasRiskyStep) return 'workflow'

  if (!shape.hasToolActivity && automation.evidence.count >= 3) return 'rule'
  if (shape.independentStepGroups >= 2) return 'workflow'
  // Archetype variety is deliberately NOT a workflow signal: verb diversity in a
  // linear checklist is not multi-role evidence; grounded parallelism above is.

  if (shape.recurring || (shape.hasVerifySignal && shape.hasRetryPattern)) return 'loop'
  return 'skill'
}
