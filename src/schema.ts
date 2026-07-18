export const CWC_FILE_VERSION = 2

export type TerminalType = 'complete' | 'escalated' | 'aborted'
export type ArtifactType = 'file' | 'text' | 'json'
export type CwcArtifactKind = 'workflow' | 'skill'
export type CwcArtifactTier = 'workflow' | 'skill' | 'loop'

export interface CwcSourceAutomation {
  id?: string
  steps: string[]
  verificationCommand?: string
  /** Observed verification instruction when no safely isolated command was available. */
  verificationStep?: string
}

export interface CwcArtifact {
  name: string
  type: ArtifactType
  path?: string  // required when type === 'file'
}

export interface CwcTrigger {
  id: string                            // trig-<8 hex>
  type: 'cron' | 'webhook'
  schedule?: string                     // cron expression (type 'cron')
  token?: string                        // uuid (type 'webhook')
  cwd: string
  targets?: string[]                    // extra repo cwds; absent/empty → run only in `cwd`
  isolation: 'worktree' | 'in-place'
  baseRef?: string                      // worktree base, default 'HEAD'
  precondition?: string                 // shell; non-zero exit → skip firing
  setupCommand?: string                 // shell, runs in run cwd before spawn; non-zero → run fails
  catchUp: boolean
  maxRunsPerDay: number
  enabled: boolean
}

export interface CwcMeta {
  id: string
  name: string
  description: string
  version: number
  created: string
  updated: string
  artifactKind?: CwcArtifactKind              // absent = 'workflow' (version-1 compatibility)
  artifactTier?: CwcArtifactTier              // distinguishes verify-only loops from plain skills
  sourceAutomation?: CwcSourceAutomation      // observed steps retained for explicit graduation
  observability?: { enabled: boolean }   // absent = enabled
  modelInvocation?: 'off' | 'auto'       // absent = 'off'
  triggers?: CwcTrigger[]
  exportedWorkflowSlug?: string          // slug of the last export; lets a rename reconcile the old skill dir
  /** Obsolete, owned deployment paths that a later same-target export should
   * retry. Kept separate so exportedWorkflowSlug always names runnable output. */
  pendingExportCleanup?: { skillSlugs?: string[]; agentSlugs?: string[] }
}

export interface CwcAgent {
  name: string
  description: string
  completionCriteria: string
  color?: string
  model?: string
  tools?: string[]
  skills?: string[]
  systemPrompt?: string
}

export interface CwcNode {
  id: string
  position: { x: number; y: number }
  exportedSlug: string | null
  startTrigger?: string
  dispatchMode?: 'parallel' | 'conditional'
  agent: CwcAgent
  agentRef?: string
  nodeType?: 'agent' | 'gate'           // absent = 'agent'
}

export interface CwcEdge {
  id: string
  from: string
  to: string | null
  label?: string
  trigger: string
  context?: CwcArtifact[]
  terminalType?: TerminalType
}

export interface CwcFile {
  meta: CwcMeta
  nodes: CwcNode[]
  edges: CwcEdge[]
}

/** Resolve the additive artifact-kind field without rewriting older version-1 files. */
export function artifactKindOf(cwc: Pick<CwcFile, 'meta'>): CwcArtifactKind {
  const kind: unknown = cwc.meta.artifactKind
  if (kind === undefined || kind === 'workflow') return 'workflow'
  if (kind === 'skill') return 'skill'
  throw new Error(`Unsupported artifact kind: ${String(kind)}`)
}

/** Persisted tier when available; otherwise derive the only tier older files can express. */
export function artifactTierOf(cwc: Pick<CwcFile, 'meta'>): CwcArtifactTier {
  const tier: unknown = cwc.meta.artifactTier
  const kind = artifactKindOf(cwc)
  if (tier === 'workflow' || tier === 'skill' || tier === 'loop') {
    if (kind === 'workflow' && tier !== 'workflow') {
      throw new Error(`A workflow artifact cannot use the ${tier} tier.`)
    }
    if (kind === 'skill' && tier === 'workflow') {
      throw new Error('A skill artifact cannot use the workflow tier.')
    }
    return tier
  }
  if (tier !== undefined) throw new Error(`Unsupported artifact tier: ${String(tier)}`)
  return kind === 'skill' ? 'skill' : 'workflow'
}
