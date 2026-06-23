import type { DetectedAutomation } from '../detection/types.js'
import type { PlanPhase, WorkflowPlan } from './plan-schema.js'
import { matchArchetype } from './archetypes.js'

export function fallbackPlan(automation: DetectedAutomation): WorkflowPlan {
  const phases: PlanPhase[] = []

  if (automation.steps.length === 0) {
    return {
      name: automation.title,
      description: automation.description,
      phases: [{ id: 'p1', intent: automation.title, stepIndexes: [0], archetypeHint: 'generic' }],
    }
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
