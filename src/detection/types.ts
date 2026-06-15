// src/detection/types.ts

/** One user-prompt-to-next-prompt slice of a session: a single "task". */
export interface TaskUnit {
  sessionId: string
  cwd: string
  gitBranch?: string
  startedAt: string          // ISO of the prompt
  endedAt: string            // ISO of the last action in the unit
  tools: string[]            // tool_use names, in order
  commands: string[]         // Bash input.command strings, in order
}

export interface InferredTrigger {
  kind: 'event' | 'schedule' | 'manual'
  label: string              // human text, e.g. "on every push" / "weekly, around Mon 09:00"
}

export interface Candidate {
  signature: string          // stable key the grouping is keyed on
  count: number              // how many task units matched
  summary: string            // human "what it noticed", e.g. "edit files → npm test → git push"
  trigger: InferredTrigger
  cwds: string[]             // distinct repos it was seen in
  lastSeen: string           // ISO of most recent occurrence
}
