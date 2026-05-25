export type TerminalType = 'complete' | 'escalated' | 'aborted'

export interface CwcMeta {
  id: string
  name: string
  description: string
  version: number
  created: string
  updated: string
}

export interface CwcAgent {
  name: string
  description: string
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
  agent: CwcAgent
}

export interface CwcEdge {
  id: string
  from: string
  to: string | null
  label?: string
  trigger: string
  context?: string[]
  terminalType?: TerminalType
}

export interface CwcFile {
  meta: CwcMeta
  nodes: CwcNode[]
  edges: CwcEdge[]
}
