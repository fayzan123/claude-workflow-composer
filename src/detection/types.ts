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
  invokedCommands?: string[] // Skill/SlashCommand invocation targets, in order
}

interface InferredTrigger {
  kind: 'event' | 'schedule' | 'manual'
  label: string              // human text, e.g. "on every push" / "weekly, around Mon 09:00"
}

export type ArtifactTier = 'rule' | 'skill' | 'loop' | 'workflow'

export interface AutomationShape {
  stepArchetypes: string[]
  distinctArchetypes: number
  hasToolActivity: boolean
  hasVerifySignal: boolean
  hasRetryPattern: boolean
  hasRiskyStep: boolean
  /** True when the risky evidence includes an irreversible or outward-facing action
   * (publish, deploy, external comms, destructive delete). Soft VCS actions such as
   * commit/push/PR keep this false. Absent on legacy shapes: classify as hard. */
  hasHardRiskyStep?: boolean
  /** Set when the evidence units are predominantly invocations of one installed
   * slash command: the repetition is already automated by that command. */
  invokedSlashCommand?: string
  independentStepGroups: number
  /** Exact consecutive observed step indexes that form the grounded parallel
   * cohort. Required when independentStepGroups is greater than one. */
  independentStepIndexes?: number[]
  recurring: boolean
  /** Exact observed external connector mutations that generated workflow agents
   * must retain in their Claude Code tool allowlist. */
  observedMutatingTools?: string[]
  /** Exact, safely-isolated command segment observed in the cited task units. */
  observedVerifyCommand?: string
}

export type RuleTarget =
  | { type: 'user-claude' }
  | { type: 'project-agents'; projectDir: string }

export type RuleApplicationTarget = RuleTarget

export interface RuleApplication {
  target: RuleApplicationTarget
  appliedAt: string
}


export interface AutomationEvidence {
  count: number
  repos: string[]
  sessionIds: string[]
  firstSeen: string
  lastSeen: string
  timing?: string
}

export type AutomationStatus = 'new' | 'dismissed' | 'promoting' | 'promotion_cancelled' | 'promotion_failed' | 'promoted'

export interface DetectedAutomation {
  id: string                 // server-derived: hash(sorted repos + sorted stepTokens)
  title: string
  description: string
  steps: string[]
  stepTokens: string[]       // grounding tokens Claude returns; feed the id
  evidence: AutomationEvidence
  suggestedTrigger: InferredTrigger & { cron?: string }
  confidence: number         // 0..1
  status: AutomationStatus
  shape?: AutomationShape    // absent on scan records created before right-sized generation
  recommendedTier?: ArtifactTier
  selectedTier?: ArtifactTier
  generatedArtifactId?: string
  /** Tier belonging to generatedArtifactId, independent of a later generation attempt. */
  generatedArtifactTier?: Exclude<ArtifactTier, 'rule'>
  ruleSuggestion?: string
  ruleApplications?: RuleApplication[]
  statusDetail?: string
  dismissedFromStatus?: Exclude<AutomationStatus, 'dismissed' | 'promoting'>
  dismissedFromStatusDetail?: string
}
