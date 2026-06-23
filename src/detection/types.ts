// src/detection/types.ts

/** One user-prompt-to-next-prompt slice of a session: a single "task". */
export interface TaskUnit {
  sessionId: string
  cwd: string
  gitBranch?: string
  promptText: string         // first text block of the user prompt (intent signal), truncated
  startedAt: string          // ISO of the prompt
  endedAt: string            // ISO of the last action in the unit
  tools: string[]            // tool_use names, in order
  commands: string[]         // Bash input.command strings, in order
}

interface InferredTrigger {
  kind: 'event' | 'schedule' | 'manual'
  label: string              // human text, e.g. "on every push" / "weekly, around Mon 09:00"
}


export interface AutomationEvidence {
  count: number
  repos: string[]
  sessionIds: string[]
  firstSeen: string
  lastSeen: string
  timing?: string
}

export interface DetectedAutomation {
  id: string                 // server-derived: hash(sorted repos + sorted stepTokens)
  title: string
  description: string
  steps: string[]
  stepTokens: string[]       // grounding tokens Claude returns; feed the id
  evidence: AutomationEvidence
  suggestedTrigger: InferredTrigger & { cron?: string }
  confidence: number         // 0..1
  status: 'new' | 'dismissed' | 'promoting' | 'promotion_cancelled' | 'promotion_failed' | 'promoted'
  statusDetail?: string
}
