import type { CwcTrigger } from '../types.ts'
import { isAbsolutePath } from './path.ts'

/** Factory for a new trigger of the given type, with sensible defaults. */
export function newTrigger(type: CwcTrigger['type']): CwcTrigger {
  return {
    id: `trig-${crypto.randomUUID().slice(0, 8)}`,
    type,
    schedule: type === 'cron' ? '0 9 * * 1-5' : undefined,
    token: type === 'webhook' ? crypto.randomUUID() : undefined,
    cwd: '',
    isolation: 'worktree',
    catchUp: true,
    maxRunsPerDay: 10,
    enabled: true,
  }
}

export function normalizeMaxRunsPerDay(value: unknown, fallback = 10): number {
  if (typeof value === 'string' && value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.floor(parsed))
}

export function normalizeTriggerForSave(trigger: CwcTrigger, targetsText: string): CwcTrigger {
  return {
    ...trigger,
    cwd: trigger.cwd.trim(),
    targets: targetsText.split('\n').map(s => s.trim()).filter(Boolean),
    maxRunsPerDay: normalizeMaxRunsPerDay(trigger.maxRunsPerDay),
  }
}

export function validateTriggerForSave(trigger: CwcTrigger): string | null {
  if (!trigger.cwd.trim()) return 'Working directory is required.'
  if (!isAbsolutePath(trigger.cwd)) return 'Working directory must be an absolute path.'
  const relativeTarget = (trigger.targets ?? []).find(t => !isAbsolutePath(t))
  if (relativeTarget) return 'Additional target repos must use absolute paths.'
  return null
}
