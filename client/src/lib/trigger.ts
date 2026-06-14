import type { CwcTrigger } from '../types.ts'

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
