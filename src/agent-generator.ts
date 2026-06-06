import { yamlScalar } from './file-writer.js'

export interface AgentSpec {
  name: string
  description: string
  whenToUse: string
  suggestedTools: string[]
  suggestedColor: string
  keyBehaviors: string[]
}

/**
 * Assemble a standalone Claude Code agent `.md` from a structured spec and a
 * generated system-prompt body. The server owns frontmatter assembly so the YAML
 * is valid by construction; Claude only supplies the prose body.
 */
export function assembleAgentFile(spec: AgentSpec, body: string): string {
  const lines = ['---']
  lines.push(`name: ${yamlScalar(spec.name)}`)
  lines.push(`description: ${yamlScalar(spec.description)}`)
  if (spec.suggestedColor) lines.push(`color: ${yamlScalar(spec.suggestedColor)}`)
  if (spec.suggestedTools && spec.suggestedTools.length > 0) {
    lines.push(`tools: ${spec.suggestedTools.join(', ')}`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n\n${body.trim()}\n`
}
