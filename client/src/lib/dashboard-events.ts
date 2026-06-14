import type { RunEventType } from '../../../src/run-events.ts'

const REFRESH_ON: ReadonlySet<RunEventType> = new Set([
  'run_started', 'run_paused', 'awaiting_approval', 'run_completed',
])

/** Whether a streamed run event should trigger a dashboard widget refresh. */
export function shouldRefreshDashboard(type: RunEventType): boolean {
  return REFRESH_ON.has(type)
}
