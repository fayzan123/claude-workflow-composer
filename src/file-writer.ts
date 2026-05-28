import type { CwcNode } from './schema.js'
import type { SkillResolution } from './skill-resolver.js'

/**
 * Render a string as a YAML scalar for frontmatter. Free-text fields like an
 * agent name or description can contain colons, leading indicators, or newlines
 * that would make a plain scalar invalid (and break YAML parsing of the exported
 * file). When that's the case we emit a double-quoted scalar with the necessary
 * escapes; simple values pass through unquoted to keep the output readable.
 */
export function yamlScalar(value: string): string {
  const needsQuoting =
    value === '' ||
    /^[\s>|@`"'#%&*!?{}[\],:-]/.test(value) ||  // ambiguous leading indicator
    /[:#]/.test(value) ||                        // colon/hash can start YAML structure
    /[\n\t]/.test(value) ||                      // control characters
    value !== value.trim()                       // surrounding whitespace
  if (!needsQuoting) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function buildFrontmatter(node: CwcNode): string {
  const { name, description, color, model, tools } = node.agent
  const lines = ['---']
  lines.push(`name: ${yamlScalar(name)}`)
  lines.push(`description: ${yamlScalar(description)}`)
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

  const { systemPrompt, completionCriteria } = node.agent
  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push('\n' + systemPrompt)
  }

  if (completionCriteria && completionCriteria.trim().length > 0) {
    parts.push(`\n\n## Completion Criteria\n\nBefore returning, verify: ${completionCriteria}`)
  }

  const ownershipComment = `<!-- cwc:node:${node.id}:workflow:${workflowId} -->`
  const hasContent = (systemPrompt && systemPrompt.trim().length > 0) ||
                     (completionCriteria && completionCriteria.trim().length > 0)

  if (resolvedSkills.length > 0) {
    const separator = hasContent ? '\n\n---\n' : '\n'
    parts.push(separator + buildSkillsBlock(resolvedSkills))
    parts.push('\n' + ownershipComment)
  } else {
    parts.push('\n' + ownershipComment)
  }

  return parts.join('')
}

export function buildWorkflowSkillContent(
  name: string,
  description: string,
  orchestratorBody: string,
  workflowId: string,
): string {
  const frontmatter = [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    'disable-model-invocation: true',
    '---',
  ].join('\n')

  return `${frontmatter}\n\n${orchestratorBody}\n<!-- cwc:workflow:${workflowId} -->`
}
