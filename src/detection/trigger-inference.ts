// src/detection/trigger-inference.ts
import type { TaskUnit, InferredTrigger } from './types.js'

const EVENT_RE = /\bgit (push|commit)\b|\bgh pr create\b/

/** Classify the natural trigger of a recurring task from its occurrences. */
export function inferTrigger(units: TaskUnit[]): InferredTrigger {
  // Event-shaped: a strong majority of occurrences carry a push/commit/PR signal.
  const withEvent = units.filter(u => u.commands.some(c => EVENT_RE.test(c))).length
  if (units.length > 0 && withEvent / units.length >= 0.6) {
    return { kind: 'event', label: 'on every push' }
  }
  // Schedule-shaped: occurrence hours cluster tightly (range <= 2h across >=3 samples).
  const hours = units.map(u => new Date(u.startedAt).getUTCHours()).filter(h => !Number.isNaN(h))
  if (hours.length >= 3) {
    const min = Math.min(...hours), max = Math.max(...hours)
    if (max - min <= 2) {
      const hh = String(Math.round((min + max) / 2)).padStart(2, '0')
      return { kind: 'schedule', label: `around ${hh}:00 (recurring)` }
    }
  }
  return { kind: 'manual', label: 'no clear trigger — run manually' }
}
