import type { DetectedAutomation } from '../detection/types.js'
import type { CapabilityCard, CatalogAgent, CatalogSkill } from '../workflow-generator.js'
import type { PlanPhase, WorkflowPlan } from './plan-schema.js'
import type { GenerationCatalog, ReuseDecision } from './compiler.js'

export const CAPABILITY_THRESHOLD = 0.34
const MIN_MATCHES = 2

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => token.length > 2)
}

export function shapeCheck(phase: PlanPhase, plan: WorkflowPlan, stepCount: number): boolean {
  const reuse = phase.reuse
  if (!reuse) return false
  if (reuse.coversStepIndexes.length === 0) return false
  if (!reuse.coversStepIndexes.every(i => Number.isInteger(i) && i >= 0 && i < stepCount)) return false
  if (plan.phases.length > 1 && stepCount > 0 && reuse.coversStepIndexes.length >= stepCount) return false
  return true
}

export function capabilityScore(
  phaseText: string,
  card: CapabilityCard | undefined,
  fallbackDescription: string,
): number {
  const phaseTokens = new Set(tokenize(phaseText))
  if (phaseTokens.size === 0) return 0

  const capabilityText = card
    ? [card.name ?? '', card.description, card.signals.join(' ')].join(' ')
    : fallbackDescription
  const capabilityTokens = new Set(tokenize(capabilityText))

  let matches = 0
  for (const token of phaseTokens) {
    if (capabilityTokens.has(token)) matches++
  }
  if (matches < MIN_MATCHES) return 0
  return matches / phaseTokens.size
}

function findSkill(catalog: GenerationCatalog, slug: string): CatalogSkill | undefined {
  return catalog.skills.find(skill => skill.slug === slug)
}

function findAgent(catalog: GenerationCatalog, slug: string): CatalogAgent | undefined {
  return catalog.agents.find(agent => agent.slug === slug)
}

function demote(reason: string): ReuseDecision {
  return { attach: false, reason }
}

export function resolveReuse(
  phase: PlanPhase,
  automation: DetectedAutomation,
  catalog: GenerationCatalog,
  plan: WorkflowPlan,
): ReuseDecision {
  const reuse = phase.reuse
  if (!reuse) return demote('no reuse requested')
  if (!shapeCheck(phase, plan, automation.steps.length)) return demote('failed shapeCheck')

  const entry = reuse.kind === 'skill' ? findSkill(catalog, reuse.slug) : findAgent(catalog, reuse.slug)
  if (!entry) return demote('slug not in live catalog')

  const phaseText = [phase.intent, ...reuse.coversStepIndexes.map(i => automation.steps[i] ?? '')].join(' ')
  const card = catalog.cards.find(c => c.kind === reuse.kind && c.slug === reuse.slug)
  const score = capabilityScore(phaseText, card, entry.description)
  if (score < CAPABILITY_THRESHOLD) return demote(`capability score ${score.toFixed(2)} below ${CAPABILITY_THRESHOLD}`)

  return { attach: true, kind: reuse.kind, slug: reuse.slug }
}
