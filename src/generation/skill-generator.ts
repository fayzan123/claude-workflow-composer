import { yamlScalar } from '../file-writer.js'
import { skillSlug } from '../slugify.js'
import { extractJsonObject } from '../json-extract.js'

export interface SkillSpec {
  name: string        // lowercase-kebab slug; == directory == frontmatter name
  description: string // "Use when…" trigger sentence
  steps: string[]     // 3–6 short procedure phrases
}

/** Assemble a standalone SKILL.md from a spec and a generated procedural body.
 *  Server owns the frontmatter (valid YAML by construction); Claude writes the body. */
export function assembleSkillFile(spec: SkillSpec, body: string): string {
  const slug = skillSlug(spec.name)
  const lines = ['---']
  lines.push(`name: ${yamlScalar(slug)}`)
  lines.push(`description: ${yamlScalar(spec.description)}`)
  lines.push('---')
  return `${lines.join('\n')}\n\n${body.trim()}\n`
}

export function parseSkillSpec(text: string): SkillSpec {
  const json = extractJsonObject(text)
  if (!json) throw new Error('Generation returned no spec JSON.')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('Generation returned no valid spec JSON.')
  }
  const steps = Array.isArray(raw['steps'])
    ? raw['steps'].filter((x): x is string => typeof x === 'string').map((s) => s.trim())
    : []
  return {
    name: String(raw['name'] ?? '').trim(),
    description: String(raw['description'] ?? '').trim(),
    steps,
  }
}

export function buildSkillSpecPrompt(userMessage: string): string {
  return `You are designing a single Claude Code skill (a reusable procedure). Based on the
user's request, produce a concise structured spec.

Respond with ONLY a JSON object — no prose, no markdown fences — with exactly these keys:
{
  "name": string,        // lowercase-kebab slug, e.g. "migration-reviewer"
  "description": string, // ONE sentence starting with "Use when…" — this is the trigger
                         // Claude Code uses to auto-select the skill.
  "steps": string[]      // 3-6 short phrases outlining the procedure the skill performs
}

If the user later asks to change the skill, return the FULL updated JSON object again.

User request: ${userMessage}`
}

export function buildSkillBuildPrompt(spec: SkillSpec): string {
  return `Write the body of a Claude Code skill (the markdown that goes AFTER the
frontmatter in SKILL.md).

DO NOT output frontmatter (no leading --- block). DO NOT wrap the output in code fences.
Output ONLY the markdown body, starting with a level-1 heading.

Skill:
- Name: ${spec.name}
- Description: ${spec.description}
- Steps: ${spec.steps.map((s) => `\n  - ${s}`).join('')}

Follow this shape:
# ${spec.name}
A one-line statement of what this skill does and when to use it. Then concrete,
actionable sections such as:
## When to use
## Steps        (numbered, specific, imperative — each step says exactly what to do)
## Output       (what the skill should produce, and in what form)

Be specific to THIS skill's job. Do NOT write generic filler like "You are a helpful assistant that ...". Every instruction must be concrete and directly usable.`
}
