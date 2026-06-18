// Shared formatting helpers for run-related UI

export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  stale: 'stale',
  complete: 'complete',
  escalated: 'escalated',
  aborted: 'aborted',
  error: 'error',
  paused: 'paused',
}

// Plain-English labels for the run timeline. Raw event types like "step_started"
// leak the data model at people who just want to know what the run is doing.
const EVENT_LABEL: Record<string, string> = {
  run_started: 'Run started',
  step_started: 'Started',
  step_completed: 'Finished',
  artifact_produced: 'Produced file',
  awaiting_approval: 'Waiting for your approval',
  run_paused: 'Paused for approval',
  run_completed: 'Run finished',
}

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, ' ')
}
