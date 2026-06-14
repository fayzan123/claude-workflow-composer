// src/server/trigger-targets.ts
import type { CwcTrigger } from '../schema.js'

/** All repo cwds a trigger should fan into: `cwd` first, then any extra targets, de-duped. */
export function resolveTargets(t: CwcTrigger): string[] {
  const all = [t.cwd, ...(t.targets ?? [])].map(s => s.trim()).filter(Boolean)
  return [...new Set(all)]
}
