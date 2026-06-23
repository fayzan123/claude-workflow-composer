import type { DetectedAutomation } from '../detection/types.js'
import type { CapabilityCard, CatalogAgent, CatalogSkill } from '../workflow-generator.js'

export interface PlannerContext {
  skills: CatalogSkill[]
  agents: CatalogAgent[]
  cards: CapabilityCard[]
}

function formatReuseCandidates(ctx: PlannerContext): string {
  const skills = ctx.skills.length
    ? ctx.skills.map(skill => `- skill:${skill.slug} - ${skill.description || skill.name || '(no description)'}`).join('\n')
    : '- none'
  const agents = ctx.agents.length
    ? ctx.agents.map(agent => `- agent:${agent.slug} - ${agent.description || agent.name}`).join('\n')
    : '- none'
  const cards = ctx.cards.length
    ? ctx.cards.map(card => {
      const signals = card.signals.length ? ` Signals: ${card.signals.join(', ')}.` : ''
      const excerpt = card.bodyExcerpt ? ` Excerpt: ${card.bodyExcerpt}` : ''
      return `- ${card.kind}:${card.slug} - ${card.description || card.name || '(no description)'}.${signals}${excerpt}`
    }).join('\n')
    : '- none'

  return `Reusable skills:
${skills}

Reusable agents:
${agents}

Capability details:
${cards}`
}

export function buildPlannerPrompt(automation: DetectedAutomation, ctx: PlannerContext): string {
  const steps = automation.steps.length
    ? automation.steps.map((step, i) => `${i}. ${step}`).join('\n')
    : '(no observed steps; create one small generic phase grounded in the title)'

  return `You are planning a Claude Workflow Composer automation. Emit only the small WorkflowPlan JSON. The compiler will write all systemPrompts, tools, edges, layout, gates, and metadata.

Automation title: ${automation.title}
Description: ${automation.description}
Runs in repo: ${automation.evidence.repos[0] ?? '(unspecified)'}

Observed steps (use these exact numbers in stepIndexes and reuse.coversStepIndexes):
${steps}

${formatReuseCandidates(ctx)}

Decomposition — MOST IMPORTANT. Choose the FEWEST phases that faithfully execute the automation. Prefer fewer, more capable phases:
- A run of plain sequential shell/CLI commands — npm/yarn/pnpm, git, build, test, typecheck, version-bump, publish, simple file edits — is ONE phase. The compiler gives that phase the Bash tool and a checklist of the commands. Do NOT split "bump version", "run tests", "build", "commit" into separate phases; separate phases add handoff latency and token cost with zero benefit.
- A separate phase earns its place ONLY when a step genuinely needs one of: different expertise/judgment than its neighbors (e.g. writing code vs. independently reviewing it), a different tool policy (e.g. a read-only reviewer vs. an agent that may publish), parallel fan-out, an approval checkpoint before irreversible work, or failure isolation. If none apply, the steps belong in the same phase.
- Group by risk boundary: keep the safe preparation/verification steps together in earlier phases, and group the irreversible or external steps (publish, deploy, push to a shared branch, delete, send messages, billing) into a single later phase so ONE approval gate guards them. Do not scatter risky steps across many phases — that creates redundant gates.

Example — observed steps "bump version, run tests, build, commit, push to main, publish to npm" become TWO phases: (1) prepare and verify the release [bump, test, build]; (2) publish the release [commit, push, publish]. The compiler inserts one approval gate before phase 2.

Return JSON only, no markdown fences, matching this shape:
{
  "name": string,
  "description": string,
  "phases": [
    {
      "id": "p1",
      "intent": "short phrase grounded in observed steps",
      "stepIndexes": [0],
      "archetypeHint": "verify|prepare|implement|review|research|publish|communicate",
      "reuse": { "kind": "skill|agent", "slug": "existing-slug-only", "coversStepIndexes": [0], "why": "why this capability fits" },
      "riskHint": ["publish|deploy|push|delete|external-message|billing"]
    }
  ]
}

Rules:
- Keep output small: about 10-15 lines of JSON, judgment only.
- Do not write systemPrompts, tools, nodes, edges, or .cwc metadata.
- Cover every observed step exactly once in phase stepIndexes unless a step is intentionally omitted because it is noise.
- Use reuse only when one listed slug clearly covers that phase. Never invent slugs.
- reuse.coversStepIndexes must reference real observed step numbers.
- A single reuse must not cover all steps of a multi-step automation unless the whole automation is truly one reusable capability.
- Add riskHint for publish, deploy, push, delete, production mutation, external messaging, billing, merge, or similar irreversible work.
- Order phases so they run sequentially; the compiler wires the handoffs.

Respond with ONLY JSON.`
}
