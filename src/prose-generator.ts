import type { CwcNode, CwcEdge } from './schema.js'
import { bfsTraversal } from './bfs.js'

function oxfordJoin(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function boldWrapAgentNames(text: string, agentNames: string[]): string {
  let result = text
  // Sort by length descending to avoid partial replacements
  for (const name of [...agentNames].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(name, `**${name}**`)
  }
  return result
}

function formatContextClause(context: string[] | undefined): string {
  if (!context || context.length === 0) return ''
  return ` Pass the ${oxfordJoin(context)} forward.`
}

export function generateOrchestratorBody(
  nodes: CwcNode[],
  edges: CwcEdge[],
  workflowName: string,
): string {
  const agentNames = nodes.map(n => n.agent.name)
  const steps = bfsTraversal(nodes, edges)
  const lines: string[] = []

  lines.push(
    `You are the orchestrator for the **${workflowName}** workflow. Delegate all implementation work via the Agent tool. Do not read, write, or edit files yourself — those are subagent responsibilities.`,
    '',
    '## Orchestration Flow',
    '',
  )

  let stepNum = 1

  // Check for multi-root parallel entry
  const level0 = steps.filter(s => s.level === 0)
  if (level0.length > 1) {
    // Multiple entry nodes — emit as parallel group at step 1
    const nameList = level0.map(s => `**${s.node.agent.name}**`).join(' and ')
    lines.push(`${stepNum++}. Start with ${nameList} in parallel:`)
    for (const s of level0) {
      const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
      lines.push(`   - **${s.node.agent.name}**${trigger}.`)
    }
  } else if (level0.length === 1) {
    const s = level0[0]
    const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
    lines.push(`${stepNum++}. Start with **${s.node.agent.name}**${trigger}.`)
  }

  // Emit forward edges
  const emitted = new Set<string>()
  // Group fan-out: for each step, if multiple non-back outgoing edges to same level, group them
  for (const step of steps) {
    const forwardEdges = step.outgoingEdges.filter(ae => !ae.isBackEdge && ae.edge.to !== null)
    const terminalEdges = step.outgoingEdges.filter(ae => ae.edge.to === null)
    const backEdges = step.outgoingEdges.filter(ae => ae.isBackEdge)

    if (forwardEdges.length > 1) {
      // Fan-out / parallel group
      const targetNames = forwardEdges.map(ae => {
        const targetNode = nodes.find(n => n.id === ae.edge.to)
        return targetNode ? `**${targetNode.agent.name}**` : ae.edge.to ?? ''
      })
      const nameList = targetNames.join(' and ')
      lines.push(`${stepNum++}. When **${step.node.agent.name}** completes, activate ${nameList} in parallel:`)
      for (const ae of forwardEdges) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`   - ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    } else if (forwardEdges.length === 1) {
      const ae = forwardEdges[0]
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`${stepNum++}. ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    }

    // Emit terminal edges for this node
    for (const ae of terminalEdges) {
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        lines.push(`${stepNum++}. ${wrapped}`)
        emitted.add(ae.edge.id)
      }
    }

    // Emit back-edges for this node (after forward edges)
    for (const ae of backEdges) {
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`${stepNum++}. ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    }
  }

  lines.push(
    '',
    '## Escalation',
    '',
    'If a subagent returns a blocked or escalation status, stop and present the details to the user before continuing.',
  )

  return lines.join('\n')
}
