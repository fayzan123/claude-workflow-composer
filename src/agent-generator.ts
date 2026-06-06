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

export const VALID_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
] as const

export const VALID_COLORS = [
  'blue', 'cyan', 'green', 'orange', 'red', 'purple', 'yellow',
] as const

/** Extract the first balanced top-level JSON object from arbitrary text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function parseSpec(text: string): AgentSpec {
  const json = extractJsonObject(text)
  if (!json) throw new Error('Generation returned no spec JSON.')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('Generation returned no valid spec JSON.')
  }
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const tools = asStringArray(raw['suggestedTools'])
    .filter((t) => (VALID_TOOLS as readonly string[]).includes(t))
  const color = typeof raw['suggestedColor'] === 'string'
    && (VALID_COLORS as readonly string[]).includes(raw['suggestedColor'] as string)
    ? (raw['suggestedColor'] as string)
    : 'blue'
  return {
    name: String(raw['name'] ?? '').trim(),
    description: String(raw['description'] ?? '').trim(),
    whenToUse: String(raw['whenToUse'] ?? '').trim(),
    suggestedTools: tools,
    suggestedColor: color,
    keyBehaviors: asStringArray(raw['keyBehaviors']).map((s) => s.trim()),
  }
}
