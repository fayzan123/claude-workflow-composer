// src/server/trigger-targets.ts
import type { CwcTrigger } from '../schema.js'

/** All repo cwds a trigger should fan into: `cwd` first, then any extra targets, de-duped. */
export function resolveTargets(t: CwcTrigger): string[] {
  const all = [t.cwd, ...(t.targets ?? [])].map(s => s.trim()).filter(Boolean)
  return [...new Set(all)]
}

export async function launchTriggerTargets<T>(
  trigger: CwcTrigger,
  launchOne: (cwd: string) => Promise<T>,
): Promise<Array<{ cwd: string; outcome: T }>> {
  return Promise.all(resolveTargets(trigger).map(async cwd => ({ cwd, outcome: await launchOne(cwd) })))
}
