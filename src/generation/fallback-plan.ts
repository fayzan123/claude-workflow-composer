import type { DetectedAutomation } from '../detection/types.js'
import { validatedIndependentStepIndexes } from '../detection/automation-shape.js'
import type { PlanPhase, WorkflowPlan } from './plan-schema.js'
import { matchArchetype } from './archetypes.js'

function parallelWindow(automation: DetectedAutomation): { start: number; end: number } | null {
  const indexes = validatedIndependentStepIndexes(automation.shape, automation.steps.length)
  if (!indexes || indexes.length < 2) return null
  return { start: indexes[0], end: indexes[indexes.length - 1] + 1 }
}

export function fallbackPlan(automation: DetectedAutomation): WorkflowPlan {
  const phases: PlanPhase[] = []

  if (automation.steps.length === 0) {
    return {
      name: automation.title,
      description: automation.description,
      phases: [{ id: 'p1', intent: automation.title, stepIndexes: [0], archetypeHint: 'generic' }],
    }
  }

  // The fallback must preserve the structural evidence that caused a workflow
  // classification. Keep every observed step grounded exactly once and mark the
  // smallest evidenced cohort as fan-out instead of silently serializing it.
  const parallel = parallelWindow(automation)
  if (parallel) {
    for (let index = 0; index < automation.steps.length; index++) {
      phases.push({
        id: `p${index + 1}`,
        intent: automation.steps[index],
        stepIndexes: [index],
        archetypeHint: matchArchetype(undefined, automation.steps[index]).id,
        ...(index >= parallel.start && index < parallel.end ? { dispatch: 'parallel' as const } : {}),
      })
    }
    return { name: automation.title, description: automation.description, phases }
  }

  let runStart = 0
  let runArchetype = matchArchetype(undefined, automation.steps[0]).id

  const flush = (endExclusive: number): void => {
    const stepIndexes: number[] = []
    for (let i = runStart; i < endExclusive; i++) stepIndexes.push(i)
    phases.push({
      id: `p${phases.length + 1}`,
      intent: automation.steps[runStart],
      stepIndexes,
      archetypeHint: runArchetype,
    })
  }

  for (let i = 1; i < automation.steps.length; i++) {
    const archetype = matchArchetype(undefined, automation.steps[i]).id
    if (archetype !== runArchetype) {
      flush(i)
      runStart = i
      runArchetype = archetype
    }
  }

  flush(automation.steps.length)
  return { name: automation.title, description: automation.description, phases }
}
