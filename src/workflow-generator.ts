// src/workflow-generator.ts
import type { CwcFile } from './schema.js'
import type { DetectedAutomation } from './detection/types.js'
import { extractJsonObject } from './json-extract.js'

/** A reusable skill the user already has, offered to the generator for reuse. */
export interface CatalogSkill { slug: string; description: string }

export function buildWorkflowGenPrompt(a: DetectedAutomation, skills: CatalogSkill[] = []): string {
  const skillsBlock = skills.length === 0 ? '' : `

The developer ALREADY HAS these reusable skills. If a step in this automation is essentially one
of these skills, set that agent's "skills" to include the skill's slug (exact string) and have the
agent INVOKE it (e.g. "Use the /<slug> skill to …") in its systemPrompt instead of re-describing
that capability from scratch. Only use slugs from THIS list; do not invent skills:
${skills.map(s => `  - ${s.slug} — ${s.description}`).join('\n')}`

  return `Generate a complete, valid Claude Workflow Composer (.cwc) workflow JSON for this
recurring task, detected from the developer's Claude Code history:

Title: ${a.title}
What it does: ${a.description}
Observed steps: ${a.steps.map(s => `\n  - ${s}`).join('') || ' (infer from the title)'}
Runs in repo: ${a.evidence.repos[0] ?? '(unspecified)'}${skillsBlock}

Design 3-6 agents with rich systemPrompts and specific completionCriteria. Respond with ONLY a
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
