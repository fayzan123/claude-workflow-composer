import type { DetectedAutomation } from '../detection/types.js'
import type { PlanPhase } from './plan-schema.js'

const RISK_RE = /\b(publish|deploy|release|push|delete|drop|rm\s+-rf|prod|production|email|slack|notify|webhook|charge|bill|payment|merge|force-push)\b/i
const HARD_RISK_RE = /\b(publish|deploy|release|push|delete|drop|rm\s+-rf|email|slack|notify|webhook|charge|bill|payment|merge|force-push)\b/i
const SAFE_VERB_RE = /\b(build|test|tests|lint|typecheck|type-check|compile)\b/i
const PROD_ONLY_RE = /\b(prod|production)\b/gi

/** Deterministic risky-phase detection, unioned with planner riskHint, minus safe verification verbs. */
export function scanRisk(phase: PlanPhase, automation: DetectedAutomation): boolean {
  const stepText = phase.stepIndexes.map(i => automation.steps[i] ?? '').join(' ')
  const hintText = (phase.riskHint ?? []).join(' ')
  const text = `${phase.intent} ${stepText} ${hintText}`.toLowerCase()

  if (!RISK_RE.test(text)) return false
  if (HARD_RISK_RE.test(text)) return true

  const prodHits = text.match(PROD_ONLY_RE) ?? []
  if (prodHits.length > 0 && SAFE_VERB_RE.test(text)) return false
  return true
}
