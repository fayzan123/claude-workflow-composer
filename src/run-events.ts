// src/run-events.ts
const RUN_EVENT_TYPES = ['run_started', 'step_started', 'step_completed', 'artifact_produced', 'run_completed', 'awaiting_approval', 'run_paused'] as const
export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

const RUN_STATUSES = ['complete', 'escalated', 'aborted', 'error'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export interface RunEvent {
  runId: string
  workflowId: string
  workflowSlug: string
  type: RunEventType
  ts: string
  nodeId?: string
  agentSlug?: string
  message?: string
  artifactPath?: string
  status?: RunStatus
  costUsd?: number
  source?: 'test' | 'external'   // server-set on ground-truth events
  cwd?: string                   // server-set on test-run run_started
  sessionId?: string
  worktreePath?: string
  branch?: string
  baseSha?: string
  trigger?: string
}

// runId/workflowId become path segments under ~/.cwc/runs/ — keep them path-safe.
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export type ValidationOutcome = { ok: true; event: RunEvent } | { ok: false; error: string }

export function validateRunEvent(raw: unknown): ValidationOutcome {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'event must be a JSON object' }
  const e = raw as Record<string, unknown>
  for (const k of ['runId', 'workflowId', 'workflowSlug', 'ts'] as const) {
    if (typeof e[k] !== 'string' || (e[k] as string).length === 0) return { ok: false, error: `missing or invalid ${k}` }
  }
  if (!SAFE_ID.test(e.runId as string)) return { ok: false, error: 'runId contains unsafe characters' }
  if (!SAFE_ID.test(e.workflowId as string)) return { ok: false, error: 'workflowId contains unsafe characters' }
  if (!RUN_EVENT_TYPES.includes(e.type as RunEventType)) return { ok: false, error: 'unknown event type' }
  if (e.type === 'run_completed' && !RUN_STATUSES.includes(e.status as RunStatus)) {
    return { ok: false, error: 'run_completed requires status: complete | escalated | aborted | error' }
  }
  return { ok: true, event: e as unknown as RunEvent }
}
