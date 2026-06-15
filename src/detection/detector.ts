// src/detection/detector.ts
import type { TaskUnit, Candidate } from './types.js'
import { deriveSignature } from './signature.js'
import { inferTrigger } from './trigger-inference.js'

export interface DetectOptions { minCount?: number; minSteps?: number }

/**
 * Group task units by salient signature; emit candidates seen >= minCount (default 3)
 * that are >= minSteps distinct steps (default 2). The minSteps gate is what makes this
 * useful: single ubiquitous commands ("build", "tests", "git push" alone) recur constantly
 * but are not *workflows* — only multi-step procedures (e.g. tests → build → push → publish)
 * are worth proposing as an automation.
 */
export function detectCandidates(units: TaskUnit[], opts: DetectOptions = {}): Candidate[] {
  const minCount = opts.minCount ?? 3
  const minSteps = opts.minSteps ?? 2
  const groups = new Map<string, { units: TaskUnit[]; summary: string }>()
  for (const unit of units) {
    const sig = deriveSignature(unit)
    if (!sig) continue
    const g = groups.get(sig.signature) ?? { units: [], summary: sig.summary }
    g.units.push(unit)
    groups.set(sig.signature, g)
  }
  const candidates: Candidate[] = []
  for (const [signature, g] of groups) {
    if (g.units.length < minCount) continue
    if (signature.split('+').length < minSteps) continue   // single ubiquitous commands are noise, not workflows
    const cwds = [...new Set(g.units.map(u => u.cwd).filter(Boolean))]
    const lastSeen = g.units.map(u => u.startedAt).filter(Boolean).sort().at(-1) ?? ''
    candidates.push({ signature, count: g.units.length, summary: g.summary, trigger: inferTrigger(g.units), cwds, lastSeen })
  }
  return candidates.sort((a, b) => b.count - a.count)
}
