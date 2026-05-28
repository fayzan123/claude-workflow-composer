import type { CwcNode, CwcEdge, CwcArtifact } from './schema.js'
import { bfsTraversal } from './bfs.js'
import { slugify } from './slugify.js'

function oxfordJoin(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function formatArtifactLabel(a: CwcArtifact): string {
  return a.type === 'file' && a.path ? `${a.name} (\`${a.path}\`)` : a.name
}

function boldWrapAgentNames(text: string, agentNames: string[]): string {
  let result = text
  for (const name of [...agentNames].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(name, `**${name}**`)
  }
  return result
}

function formatContextClause(context: CwcArtifact[] | undefined): string {
  if (!context || context.length === 0) return ''
  return ` Pass the ${oxfordJoin(context.map(formatArtifactLabel))} forward.`
}

function nodeSlug(node: CwcNode): string {
  return node.agentRef ?? node.exportedSlug ?? slugify(node.agent.name)
}

export interface OverrideInfo {
  model?: string
  skills?: string[]
  tools?: string[]
  systemPrompt?: string
  completionCriteria?: string
}

function formatOverrideAnnotation(nodeId: string, overrides: Record<string, OverrideInfo>): string {
  const o = overrides[nodeId]
  if (!o) return ''

  const parts: string[] = []
  if (o.model) parts.push(`model (${o.model})`)
  if (o.skills && o.skills.length > 0) parts.push(`additional skills (${o.skills.join(', ')})`)
  if (o.tools && o.tools.length > 0) parts.push(`tools (${o.tools.join(', ')})`)
  if (o.systemPrompt && o.systemPrompt.trim()) {
    const snippet = o.systemPrompt.trim().slice(0, 80)
    parts.push(`prompt "${snippet}${o.systemPrompt.length > 80 ? '...' : ''}"`)
  }
  if (o.completionCriteria && o.completionCriteria.trim()) {
    const snippet = o.completionCriteria.trim().slice(0, 80)
    parts.push(`completion "${snippet}${o.completionCriteria.length > 80 ? '...' : ''}"`)
  }

  if (parts.length === 0) return ''
  return ` Workflow-specific configuration: ${parts.join(', ')}.`
}

export function generateOrchestratorBody(
  nodes: CwcNode[],
  edges: CwcEdge[],
  workflowName: string,
  nodeOverrides: Record<string, OverrideInfo> = {},
): string {
  const agentNames = nodes.map(n => n.agent.name)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const steps = bfsTraversal(nodes, edges)
  const lines: string[] = []

  lines.push(
    `I am the orchestrator for the **${workflowName}** workflow. I coordinate this pipeline exclusively through the Agent tool — I do not read, write, or edit files myself. All implementation work is delegated to subagents.`,
    '',
    '## Pipeline',
    '',
  )

  let stepNum = 1

  const level0 = steps.filter(s => s.level === 0)
  if (level0.length > 1) {
    const nameList = level0.map(s => `**${s.node.agent.name}**`).join(' and ')
    lines.push(`${stepNum++}. Invoke ${nameList} in parallel:`)
    for (const s of level0) {
      const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
      const overrides = formatOverrideAnnotation(s.node.id, nodeOverrides)
      lines.push(`   - **${s.node.agent.name}** (\`subagent_type: "${nodeSlug(s.node)}"\`)${trigger}.${overrides}`)
    }
  } else if (level0.length === 1) {
    const s = level0[0]
    const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
    const overrides = formatOverrideAnnotation(s.node.id, nodeOverrides)
    lines.push(`${stepNum++}. Invoke **${s.node.agent.name}** (\`subagent_type: "${nodeSlug(s.node)}"\`)${trigger}.${overrides}`)
  }

  const emitted = new Set<string>()

  for (const step of steps) {
    const forwardEdges = step.outgoingEdges.filter(ae => !ae.isBackEdge && ae.edge.to !== null)
    const terminalEdges = step.outgoingEdges.filter(ae => ae.edge.to === null)
    const backEdges = step.outgoingEdges.filter(ae => ae.isBackEdge)

    if (forwardEdges.length > 1) {
      const targets = forwardEdges.map(ae => nodeMap.get(ae.edge.to!)).filter(Boolean) as CwcNode[]
      const nameList = targets.map(n => `**${n.agent.name}**`).join(' and ')
      lines.push(`${stepNum++}. When **${step.node.agent.name}** completes, invoke ${nameList} in parallel:`)
      for (const ae of forwardEdges) {
        const target = nodeMap.get(ae.edge.to!)
        if (!target) continue
        const trigger = ae.edge.trigger.trim() || `Activate **${target.agent.name}**.`
        const ctx = formatContextClause(ae.edge.context)
        const overrides = formatOverrideAnnotation(ae.edge.to!, nodeOverrides)
        lines.push(`   - **${target.agent.name}** (\`subagent_type: "${nodeSlug(target)}"\`): ${trigger}${ctx}${overrides}`)
        emitted.add(ae.edge.id)
      }
    } else if (forwardEdges.length === 1) {
      const ae = forwardEdges[0]
      if (!emitted.has(ae.edge.id)) {
        const target = nodeMap.get(ae.edge.to!)
        if (target) {
          const raw = ae.edge.trigger.trim() || `Invoke **${target.agent.name}**.`
          const trigger = boldWrapAgentNames(raw, agentNames)
          const ctx = formatContextClause(ae.edge.context)
          const overrides = formatOverrideAnnotation(ae.edge.to!, nodeOverrides)
          lines.push(`${stepNum++}. ${trigger} Use the Agent tool with \`subagent_type: "${nodeSlug(target)}"\`.${ctx}${overrides}`)
        }
        emitted.add(ae.edge.id)
      }
    }

    for (const ae of terminalEdges) {
      if (!emitted.has(ae.edge.id)) {
        const raw = ae.edge.trigger.trim() || `**${step.node.agent.name}** completes the workflow.`
        lines.push(`${stepNum++}. ${boldWrapAgentNames(raw, agentNames)}`)
        emitted.add(ae.edge.id)
      }
    }

    for (const ae of backEdges) {
      if (!emitted.has(ae.edge.id)) {
        const target = nodeMap.get(ae.edge.to!)
        const raw = ae.edge.trigger.trim() || (target ? `Return to **${target.agent.name}**.` : '')
        const trigger = boldWrapAgentNames(raw, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`${stepNum++}. ${trigger}${ctx}`)
        emitted.add(ae.edge.id)
      }
    }
  }

  lines.push(
    '',
    '## Scope Boundary',
    '',
    'Append the following to every subagent prompt:',
    '',
    '> Operate within the scope defined in this prompt. Escalate if the required work falls outside that scope.',
    '',
    '## Escalation',
    '',
    'After every subagent returns, check its response. If `status` is `blocked` or `escalation_needed`, stop immediately and present the issue to the user — do not attempt to work around it.',
    '',
    '## Completion',
    '',
    'When all steps finish, present a summary to the user: which agents ran, what each produced, and any escalations or skipped steps.',
  )

  return lines.join('\n')
}
