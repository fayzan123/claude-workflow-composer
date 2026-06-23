export interface PlanReuse {
  kind: 'skill' | 'agent'
  slug: string
  coversStepIndexes: number[]
  why: string
}

export interface PlanPhase {
  id: string
  intent: string
  stepIndexes: number[]
  archetypeHint?: string
  reuse?: PlanReuse
  dispatch?: 'sequential' | 'parallel' | 'conditional'
  riskHint?: string[]
}

export interface WorkflowPlan {
  name: string
  description: string
  phases: PlanPhase[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validIndex(n: unknown, stepCount: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < stepCount
}

function validateReuse(value: unknown, stepCount: number): PlanReuse | undefined {
  if (!isRecord(value)) return undefined
  const { kind, slug, coversStepIndexes, why } = value
  if (kind !== 'skill' && kind !== 'agent') return undefined
  if (typeof slug !== 'string' || slug.length === 0) return undefined
  if (!Array.isArray(coversStepIndexes) || coversStepIndexes.length === 0) return undefined
  if (!coversStepIndexes.every(i => validIndex(i, stepCount))) return undefined
  return { kind, slug, coversStepIndexes: [...coversStepIndexes], why: typeof why === 'string' ? why : '' }
}

function validatePhase(value: unknown, stepCount: number): PlanPhase | null {
  if (!isRecord(value)) return null
  const { id, intent, stepIndexes, archetypeHint, reuse, dispatch, riskHint } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof intent !== 'string' || intent.length === 0) return null
  if (!Array.isArray(stepIndexes) || stepIndexes.length === 0) return null
  if (!stepIndexes.every(i => validIndex(i, stepCount))) return null
  const phase: PlanPhase = { id, intent, stepIndexes: [...stepIndexes] }
  if (typeof archetypeHint === 'string') phase.archetypeHint = archetypeHint
  const r = validateReuse(reuse, stepCount)
  if (r) phase.reuse = r
  if (dispatch === 'sequential' || dispatch === 'parallel' || dispatch === 'conditional') phase.dispatch = dispatch
  if (Array.isArray(riskHint)) phase.riskHint = riskHint.filter((h): h is string => typeof h === 'string')
  return phase
}

/** Returns the typed plan if structurally valid for an automation with `stepCount` steps, else null. */
export function validatePlan(value: unknown, stepCount: number): WorkflowPlan | null {
  if (!isRecord(value)) return null
  const { name, description, phases } = value
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof description !== 'string') return null
  if (!Array.isArray(phases) || phases.length === 0) return null
  const out: PlanPhase[] = []
  for (const p of phases) {
    const phase = validatePhase(p, stepCount)
    if (!phase) return null
    out.push(phase)
  }
  return { name, description, phases: out }
}
