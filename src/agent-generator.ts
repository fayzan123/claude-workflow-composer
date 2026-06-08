import { yamlScalar } from './file-writer.js'
import { extractJsonObject } from './json-extract.js'

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
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
] as const

export const VALID_COLORS = [
  'blue', 'cyan', 'green', 'orange', 'red', 'purple', 'yellow',
] as const

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

export function buildSpecPrompt(userMessage: string): string {
  return `You are designing a single Claude Code subagent. Based on the user's request,
produce a concise structured spec.

Respond with ONLY a JSON object — no prose, no markdown fences — with exactly these keys:
{
  "name": string,            // Title Case, human-readable, e.g. "Migration Reviewer"
  "description": string,     // ONE sentence: the specialty and what it does. This is the
                             // auto-selection trigger Claude Code uses to pick this agent.
  "whenToUse": string,       // ONE sentence: the situation that should trigger this agent.
  "suggestedTools": string[],// subset of EXACTLY these: ${VALID_TOOLS.join(', ')}. Omit tools it does not need.
  "suggestedColor": string,  // one of: ${VALID_COLORS.join(', ')}
  "keyBehaviors": string[]   // 3-6 short bullet phrases describing what the agent does
}

If the user later asks to change the agent, return the FULL updated JSON object again.

User request: ${userMessage}`
}

export function buildBuildPrompt(spec: AgentSpec): string {
  return `Write the system prompt body for the Claude Code subagent below. This is the
markdown that goes AFTER the frontmatter in the agent's .md file.

DO NOT output frontmatter (no leading --- block). DO NOT wrap the output in code fences.
Output ONLY the markdown body, starting with a level-1 heading.

Agent:
- Name: ${spec.name}
- Description: ${spec.description}
- When to use: ${spec.whenToUse}
- Tools: ${spec.suggestedTools.join(', ') || '(all tools)'}
- Key behaviors: ${spec.keyBehaviors.map((b) => `\n  - ${b}`).join('')}

Follow this exact structure (matches the agency-agents standard):
# ${spec.name}
A strong opener: "You are **${spec.name}**, a [role] who ..." — give it identity, a
point of view, and stakes. Then these sections:
## Your Identity & Memory   (Role / Personality / Experience)
## Your Core Mission        (### capability areas as bullets; include a "**Default requirement**:" line)
## Critical Rules You Must Follow   (never/always statements)
## Your Deliverables        (concrete output formats, shown in fenced code blocks)
## Your Workflow Process    (Step 1 … Step N)
## Your Communication Style (example phrasings in quotes)
## Your Success Metrics     ("You're successful when:" — measurable outcomes)

Be specific to THIS agent's job. Do NOT write generic filler like "You are a helpful assistant that ...". Every section must be concrete and actionable for ${spec.name}.`
}

