// src/detection/trigger-inference.ts
import type { TaskUnit, InferredTrigger } from './types.js'

/**
 * Classify the natural trigger of a recurring task from its occurrences.
 *
 * NOTE: event-trigger inference ("on every push") is intentionally NOT done here. A task
 * that *contains* a push isn't *triggered* by one — the real trigger is the task's
 * ANTECEDENT (what happened just before it), which historical, prompt-bounded task units
 * can't see reliably. Claiming "on push" from task contents is a confident wrong guess, so
 * from history we infer only SCHEDULE (regular-hour clustering) vs MANUAL. Event inference
 * is deferred to the live Stop hook (Plan 2), which sees real antecedent context.
 */
export function inferTrigger(units: TaskUnit[]): InferredTrigger {
  // Schedule-shaped: occurrence hours cluster tightly (range <= 2h across >=3 samples).
  const hours = units.map(u => new Date(u.startedAt).getUTCHours()).filter(h => !Number.isNaN(h))
  if (hours.length >= 3) {
    const min = Math.min(...hours), max = Math.max(...hours)
    if (max - min <= 2) {
      const hh = String(Math.round((min + max) / 2)).padStart(2, '0')
      return { kind: 'schedule', label: `around ${hh}:00 UTC (recurring)` }
    }
  }
  return { kind: 'manual', label: 'no clear trigger — choose when to run it' }
}
