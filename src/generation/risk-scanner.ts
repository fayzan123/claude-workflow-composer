import type { DetectedAutomation } from '../detection/types.js'
import type { PlanPhase } from './plan-schema.js'
import { hasExternalAction } from './external-action-risk.js'

const RISK_RE = /\b(delete|drop|rm\s+-rf|prod|production|charge|bill|payment|force-push)\b/i
const HARD_RISK_RE = /\b(delete|drop|rm\s+-rf|charge|bill|payment|force-push)\b/i
const SAFE_VERB_RE = /\b(build|test|tests|lint|typecheck|type-check|compile)\b/i
const PROD_ONLY_RE = /\b(prod|production)\b/gi

/** Deterministic risky-phase detection, unioned with planner riskHint, minus safe verification verbs. */
export function scanRisk(phase: PlanPhase, automation: DetectedAutomation): boolean {
  const stepText = phase.stepIndexes.map(i => automation.steps[i] ?? '').join(' ')
  const hintText = (phase.riskHint ?? []).join(' ')
  const text = `${phase.intent} ${stepText} ${hintText}`.toLowerCase()

  if (hasExternalAction(text)) return true
  if (!RISK_RE.test(text)) return false
  if (HARD_RISK_RE.test(text)) return true

  const prodHits = text.match(PROD_ONLY_RE) ?? []
  if (prodHits.length > 0 && SAFE_VERB_RE.test(text)) return false
  return true
}
