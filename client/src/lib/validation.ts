import type { CwcFile } from '../../../src/schema.ts'
import { slugify } from '../../../src/slugify.ts'

export interface ValidationError { type: string; nodeId?: string; message: string }
export interface ValidationWarning { type: string; nodeId?: string; message: string }
export interface ValidationResult { errors: ValidationError[]; warnings: ValidationWarning[]; canExport: boolean }

export function validateWorkflow(cwc: CwcFile): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (cwc.nodes.length === 0) {
    return { errors, warnings, canExport: false }
  }

  const slugCounts = new Map<string, string[]>()
  for (const node of cwc.nodes) {
    if (!node.agent.name.trim()) {
      errors.push({ type: 'missing-name', nodeId: node.id, message: 'Agent needs a name before export' })
      continue
    }
    if (node.nodeType === 'gate') continue
    if (!node.agentRef && !node.agent.completionCriteria?.trim()) {
      warnings.push({ type: 'missing-completion-criteria', nodeId: node.id, message: 'Add completion criteria so the agent knows when to stop' })
    }
    const slug = node.agentRef ?? slugify(node.agent.name)
    const existing = slugCounts.get(slug) ?? []
    slugCounts.set(slug, [...existing, node.id])
  }

  for (const [, nodeIds] of slugCounts) {
    if (nodeIds.length > 1) {
      nodeIds.forEach((nodeId) =>
        errors.push({ type: 'duplicate-slug', nodeId, message: 'Two agents produce the same filename — rename one' })
      )
    }
  }

  const incoming = new Set(cwc.edges.filter((e) => e.to).map((e) => e.to!))
  for (const node of cwc.nodes) {
    if (node.nodeType !== 'gate') continue
    if (!incoming.has(node.id)) {
      errors.push({ type: 'gate-entry', nodeId: node.id, message: 'A gate cannot start the workflow — connect an agent before it' })
    }
    for (const e of cwc.edges) {
      if (e.from === node.id && e.to && cwc.nodes.find((n) => n.id === e.to)?.nodeType === 'gate') {
        errors.push({ type: 'gate-adjacent', nodeId: node.id, message: 'Two gates in a row — merge them into one' })
      }
    }
  }

  // A handoff with no trigger still exports, but the orchestrator falls back to generic
  // prose to decide when to advance. Warn (don't block) — the field is marked required in
  // the edge panel, so it should at least surface here instead of silently passing.
  for (const e of cwc.edges) {
    if (e.to !== null && !e.trigger?.trim()) {
      warnings.push({ type: 'missing-trigger', nodeId: e.from, message: 'This handoff has no trigger — the orchestrator will guess when to advance' })
    }
  }

  if (cwc.edges.length > 0) {
    const nodesWithIncoming = new Set(cwc.edges.filter((e) => e.to).map((e) => e.to!))
    const nodesWithOutgoing = new Set(cwc.edges.map((e) => e.from))
    const hasTerminalEdge = new Set(cwc.edges.filter((e) => e.to === null).map((e) => e.from))

    for (const node of cwc.nodes) {
      const hasIn = nodesWithIncoming.has(node.id)
      const hasOut = nodesWithOutgoing.has(node.id)
      const isTerminal = hasTerminalEdge.has(node.id)
      if (!hasIn && !hasOut) {
        warnings.push({ type: 'disconnected-node', nodeId: node.id, message: "This agent isn't connected to the workflow" })
      } else if (!hasOut && !isTerminal) {
        warnings.push({ type: 'no-handoff', nodeId: node.id, message: 'This agent has no handoff — add an arrow or mark it as a workflow end' })
      }
    }
  }

  return { errors, warnings, canExport: errors.length === 0 }
}
