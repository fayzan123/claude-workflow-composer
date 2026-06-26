export type TerminalType = 'complete' | 'escalated' | 'aborted'
export type ArtifactType = 'file' | 'text' | 'json'

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
  observability?: { enabled: boolean }   // absent = enabled
  modelInvocation?: 'off' | 'auto'       // absent = 'off'
  triggers?: CwcTrigger[]
  exportedWorkflowSlug?: string          // slug of the last export; lets a rename reconcile the old skill dir
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
