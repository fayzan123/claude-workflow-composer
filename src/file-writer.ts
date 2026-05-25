import type { CwcNode } from './schema.js'
import type { SkillResolution } from './skill-resolver.js'

function buildFrontmatter(node: CwcNode): string {
  const { name, description, color, model, tools } = node.agent
  const lines = ['---']
  lines.push(`name: ${name}`)
  lines.push(`description: ${description}`)
  if (color) lines.push(`color: ${color}`)
  if (model) lines.push(`model: ${model}`)
  if (tools && tools.length > 0) lines.push(`tools: ${tools.join(', ')}`)
  lines.push('---')
  return lines.join('\n')
}

function buildSkillsBlock(skills: SkillResolution[]): string {
  const lines = skills.map(s =>
    s.description
      ? `Use the \`${s.slug}\` skill. (${s.description})`
      : `Use the \`${s.slug}\` skill.`
  )
  return `## Workflow Skills\n\n${lines.join('\n')}`
}

export function buildAgentFileContent(
  node: CwcNode,
  resolvedSkills: SkillResolution[],
  workflowId: string,
): string {
  const parts: string[] = []
  parts.push(buildFrontmatter(node))

  const { systemPrompt } = node.agent
  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push('\n' + systemPrompt)
  }

  const ownershipComment = `<!-- cwc:node:${node.id}:workflow:${workflowId} -->`

  if (resolvedSkills.length > 0) {
    const separator = systemPrompt && systemPrompt.trim().length > 0
      ? '\n\n---\n'
      : '\n'
    parts.push(separator + buildSkillsBlock(resolvedSkills))
    parts.push('\n' + ownershipComment)
  } else {
    parts.push('\n' + ownershipComment)
  }

  return parts.join('')
}

export function buildWorkflowSkillContent(
  workflowSlug: string,
  description: string,
  orchestratorBody: string,
  workflowId: string,
): string {
  const frontmatter = [
    '---',
    `name: ${workflowSlug}`,
    `description: ${description}`,
    'disable-model-invocation: true',
    '---',
  ].join('\n')

  return `${frontmatter}\n\n${orchestratorBody}\n<!-- cwc:workflow:${workflowId} -->`
}
