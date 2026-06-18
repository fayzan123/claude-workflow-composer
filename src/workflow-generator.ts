// src/workflow-generator.ts
import type { CwcFile } from './schema.js'
import type { DetectedAutomation } from './detection/types.js'
import { extractJsonObject } from './json-extract.js'

/** A reusable skill the user already has, offered to the generator for reuse. */
export interface CatalogSkill { slug: string; description: string }

export function buildWorkflowGenPrompt(a: DetectedAutomation, skills: CatalogSkill[] = []): string {
  const skillsBlock = skills.length === 0 ? '' : `

REUSE THE DEVELOPER'S EXISTING SKILLS — this is the most important instruction.
They already have these skills (slug — what it does):
${skills.map(s => `  - ${s.slug} — ${s.description}`).join('\n')}
Rules for using them:
- If this automation is ESSENTIALLY one of these skills, generate a MINIMAL workflow — ideally a
  SINGLE agent whose job is to invoke that skill (put the exact slug in its "skills"; its
  systemPrompt says "Run the /<slug> skill on <input>"). The skill already does the work end to end.
- Attach AT MOST ONE skill per agent — the single best fit. NEVER stack multiple skills on one
  agent; that is wasteful, unclear, and not how these skills are used.
- Many skills already perform their own later phases internally — e.g. an implementation/development
  skill that runs its OWN review, verification, and branch-finishing loop. If you use such a skill,
  do NOT add separate review / verify / commit / finish agents: that duplicates the skill, burns
  tokens, and a flat graph can't express the back-and-forth the skill already handles internally.
  Trust the skill to do those phases.
- Use slugs ONLY from the list above — never invent one.`

  return `Generate a complete, valid Claude Workflow Composer (.cwc) workflow JSON for this
recurring task, detected from the developer's Claude Code history:

Title: ${a.title}
What it does: ${a.description}
Observed steps: ${a.steps.map(s => `\n  - ${s}`).join('') || ' (infer from the title)'}
Runs in repo: ${a.evidence.repos[0] ?? '(unspecified)'}${skillsBlock}

Default to ONE agent. Only add another agent for a genuinely distinct phase that NO single skill
already covers — never split work that one skill handles end-to-end into multiple agents, and never
add review/commit/finish agents after a skill that already does those internally. Fewer agents means
fewer tokens at runtime. Cap at 6. Each agent needs ONE clear responsibility, a specific
completionCriteria, and a concrete systemPrompt. Respond with ONLY a
JSON object — no prose, no markdown fences — matching exactly:
{
  "meta": { "id": string, "name": string, "description": string, "version": 1, "created": string, "updated": string },
  "nodes": [ { "id": string, "position": {"x": number, "y": number}, "exportedSlug": null,
    "dispatchMode"?: "parallel"|"conditional",
    "agent": { "name": string, "description": string, "completionCriteria": string,
      "color"?: string, "tools"?: string[], "skills"?: string[], "systemPrompt"?: string } } ],
  "edges": [ { "id": string, "from": string, "to": string|null, "trigger": string,
    "label"?: string, "terminalType"?: "complete"|"escalated"|"aborted" } ]
}
Rules: every edge.from matches a node id; every edge.to matches a node id OR is null with a
terminalType; exportedSlug is always null; node agent.name values are unique and non-empty;
"skills" holds slugs ONLY from the list above (or [] if none apply).
Lay nodes out left-to-right at y≈300, x stepping by 350 (no two nodes at 0,0).`
}

export function parseWorkflowJson(text: string): CwcFile {
  const json = extractJsonObject(text)
  if (!json) throw new Error('Generation returned no workflow JSON.')
  let cwc: CwcFile
  try { cwc = JSON.parse(json) as CwcFile } catch { throw new Error('Generation returned invalid workflow JSON.') }
  if (!cwc.meta?.name || !Array.isArray(cwc.nodes) || !Array.isArray(cwc.edges)) {
    throw new Error('Generated workflow is missing meta/nodes/edges.')
  }
  const ids = new Set(cwc.nodes.map(n => n.id))
  for (const n of cwc.nodes) { n.exportedSlug = null }
  for (const e of cwc.edges) {
    if (!ids.has(e.from)) throw new Error(`Edge ${e.id} from unknown node ${e.from}.`)
    if (e.to !== null && !ids.has(e.to)) throw new Error(`Edge ${e.id} to unknown node ${e.to}.`)
  }
  return cwc
}
