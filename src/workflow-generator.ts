// src/workflow-generator.ts
import type { CwcFile } from './schema.js'
import type { DetectedAutomation } from './detection/types.js'
import { extractJsonObject } from './json-extract.js'

/** A reusable skill the user already has, offered to the generator for reuse. */
export interface CatalogSkill {
  slug: string
  description: string
  name?: string
  source?: 'user' | 'plugin'
  filePath?: string
}

/** A reusable agent the user already has, offered to the generator for reuse via agentRef. */
export interface CatalogAgent {
  slug: string
  name: string
  description: string
  source?: 'user' | 'project'
  filePath?: string
}

export interface CapabilityCard {
  kind: 'skill' | 'agent'
  slug: string
  name?: string
  description: string
  source?: string
  bodyExcerpt: string
  signals: string[]
}

export interface WorkflowGenContext {
  skills?: CatalogSkill[]
  agents?: CatalogAgent[]
  capabilityCards?: CapabilityCard[]
}

function normalizeContext(input: CatalogSkill[] | WorkflowGenContext): WorkflowGenContext {
  return Array.isArray(input) ? { skills: input } : input
}

export function buildWorkflowGenPrompt(a: DetectedAutomation, reuse: CatalogSkill[] | WorkflowGenContext = []): string {
  const { skills = [], agents = [], capabilityCards = [] } = normalizeContext(reuse)
  const skillsBlock = skills.length === 0 ? '' : `

REUSE THE DEVELOPER'S EXISTING SKILLS — this is the most important instruction.
They already have these skills (slug — what it does):
${skills.map(s => `  - ${s.slug} — ${s.description}`).join('\n')}
Rules for using them:
- If this automation is ESSENTIALLY one of these skills and the skill clearly covers every major
  observed step, generate a MINIMAL workflow — ideally a SINGLE agent whose job is to invoke that
  skill (put the exact slug in its "skills"; its systemPrompt says "Run the /<slug> skill on
  <input>"). The skill already does the work end to end.
- If a skill covers only part of the automation, use it for that phase and create additional nodes
  for the remaining observed phases. Do not hide uncovered work inside one oversized prompt.
- Attach AT MOST ONE skill per agent — the single best fit. NEVER stack multiple skills on one
  agent; that is wasteful, unclear, and not how these skills are used.
- Many skills already perform their own later phases internally — e.g. an implementation/development
  skill that runs its OWN review, verification, and branch-finishing loop. If you use such a skill,
  do NOT add separate review / verify / commit / finish agents: that duplicates the skill, burns
  tokens, and a flat graph can't express the back-and-forth the skill already handles internally.
  Trust the skill to do those phases.
- Use slugs ONLY from the list above — never invent one.`

  const agentsBlock = agents.length === 0 ? '' : `

REUSE EXISTING AGENTS WHEN THEIR ROLE ALREADY MATCHES.
They already have these agents (agentRef slug — role):
${agents.map(a => `  - ${a.slug} — ${a.description || a.name}`).join('\n')}
Rules for using existing agents:
- If an existing agent is the right durable role/persona/tool policy, set "agentRef" to the
  exact slug and keep that node minimal. CWC will reference the existing agent file instead of
  generating a duplicate.
- Do NOT attach skills to an agentRef node; existing agent files define their own behavior.
- Use agentRef slugs ONLY from the list above — never invent one.`

  const cardsBlock = capabilityCards.length === 0 ? '' : `

CAPABILITY DETAILS FOR TOP REUSE FINALISTS.
These excerpts are authoritative. Use them to decide whether a skill/agent subsumes the automation,
not just name overlap:
${capabilityCards.map((c, i) => {
  const label = c.kind === 'skill' ? `Skill ${c.slug}` : `Agent ${c.slug}`
  const signals = c.signals.length > 0 ? `\nSignals: ${c.signals.join(', ')}` : ''
  return `
[${i + 1}] ${label}${c.name ? ` (${c.name})` : ''}
Description: ${c.description || '(none)'}${signals}
Excerpt:
${c.bodyExcerpt || '(no body excerpt)'}`
}).join('\n')}

Composition guidance:
- If one skill clearly covers the detected automation end to end, generate a one-node wrapper
  using that single skill. Do not decompose its internal review, verification, or finish steps.
- If capability coverage is partial, use the skill/agent for the phase it truly covers and add
  explicit nodes for the uncovered phases.
- If an existing agent already embodies a needed role, use agentRef instead of recreating it.
- Only create bespoke agents for gaps not covered by these capabilities.`

  return `Generate a complete, valid Claude Workflow Composer (.cwc) workflow JSON for this
recurring task, detected from the developer's Claude Code history:

Title: ${a.title}
What it does: ${a.description}
Observed steps: ${a.steps.map(s => `\n  - ${s}`).join('') || ' (infer from the title)'}
Runs in repo: ${a.evidence.repos[0] ?? '(unspecified)'}${skillsBlock}${agentsBlock}${cardsBlock}

Choose the smallest workflow that faithfully executes the observed automation. Do NOT default to a
single generic agent unless one existing skill/agent explicitly covers the whole automation end to
end, or the automation is genuinely one indivisible task.

If no capability fully subsumes it, model the observed steps as durable workflow phases. Use as
many or as few agents as the automation needs to run efficiently and predictably. Add a separate
agent when doing so improves correctness, reuse, parallelism, checkpointing, validation, handoff
clarity, or failure recovery. Do not add agents just to make the graph look more complex.

Preserve the evidence: every major observed step must be handled either by a reused skill/agent that
clearly covers it or by an explicit node/edge. Never split work that one skill handles end-to-end
into multiple agents, and never add review/commit/finish agents after a skill that already does
those internally. Stop splitting when another agent would not improve the user's ability to
understand, run, monitor, or trust the automation. Each agent needs ONE clear responsibility, a
specific completionCriteria, and a concrete systemPrompt. Respond with ONLY a
JSON object — no prose, no markdown fences — matching exactly:
{
  "meta": { "id": string, "name": string, "description": string, "version": 1, "created": string, "updated": string },
  "nodes": [ { "id": string, "position": {"x": number, "y": number}, "exportedSlug": null,
    "agentRef"?: string,
    "dispatchMode"?: "parallel"|"conditional",
    "agent": { "name": string, "description": string, "completionCriteria": string,
      "color"?: string, "tools"?: string[], "skills"?: string[], "systemPrompt"?: string } } ],
  "edges": [ { "id": string, "from": string, "to": string|null, "trigger": string,
    "label"?: string, "terminalType"?: "complete"|"escalated"|"aborted" } ]
}
Rules: every edge.from matches a node id; every edge.to matches a node id OR is null with a
terminalType; exportedSlug is always null; node agent.name values are unique and non-empty;
"skills" holds slugs ONLY from the skills list above (or [] if none apply); "agentRef" holds
slugs ONLY from the agent list above and is omitted when no existing agent applies.
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
