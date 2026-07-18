export interface Archetype {
  id: string
  signals: RegExp
  tools: string[]
  risky: boolean
}

const ARCHETYPES: Archetype[] = [
  { id: 'verify', signals: /\b(test|tests|lint|typecheck|type-check|build|compile|verify|validate|check)\b/i, tools: ['Bash', 'Read'], risky: false },
  { id: 'prepare', signals: /\b(scaffold|duplicate|clone|copy|setup|set up|bump|version|configure|prepare|init|generate)\b/i, tools: ['Read', 'Edit', 'Write', 'Bash'], risky: false },
  { id: 'implement', signals: /\b(implement|write|add|create|build feature|code|fix|refactor|edit)\b/i, tools: ['Read', 'Edit', 'Write', 'Bash'], risky: false },
  { id: 'review', signals: /\b(review|inspect|audit|analyze|examine|read)\b/i, tools: ['Read'], risky: false },
  { id: 'research', signals: /\b(research|search|gather|find|look up|investigate|browse)\b/i, tools: ['WebSearch', 'WebFetch', 'Read'], risky: false },
  // The zero-width action lookahead plus the consumed verb+PR alternative
  // intentionally scores "create/open/merge a PR" above the generic `create`
  // implementation signal. A bare PR mention ("update the PR description") is
  // deliberately not a publish signal: mentioning a PR is not an external action.
  { id: 'publish', signals: /\b(?:publish|deploy|push|upload)\b|\bship\s+(?:(?:the|a|this)\s+)?(?:service|app|site|build|release|code)\b|\brelease\s+(?:(?:the|a|an|this|new)\s+)?(?:package|version|build|artifact|candidate|software|app|service)\b|\b(?:create|cut|ship|publish)\s+(?:(?:a|the|new)\s+)?release\b|\bmerge\s+(?:(?:the|a|this)\s+)?(?:pull request|pr|branch|changes?|commits?|code)\b|\b(?:create|push)\s+(?:(?:a|the|this)\s+)?tag\b|(?=\b(?:open|create|merge|submit)\s+(?:(?:a|the|this)\s+)?(?:pull request|pr)\b)|(?<=\b(?:open|create|merge|submit)\s+(?:(?:a|the|this)\s+)?)(?:pull request|pr)\b/i, tools: ['Bash'], risky: true },
  { id: 'communicate', signals: /\b(?:send|notify|announce)\b|\bemail\s+(?:the|a|an|our|their|team|user|customer|reviewer)\b|\bpost\s+(?:(?:(?:a|the|this)\s+)?(?:(?:release|deployment|status|project|team|customer)\s+)?(?:message|announcement|update)|(?:to|on)\b)|\bmessage\s+(?:the|a|an|our|their|team|user|channel|customer|reviewer)\b|\btrigger\s+(?:(?:a|the)\s+)?webhook\b/i, tools: ['Bash', 'WebFetch'], risky: true },
]

export const GENERIC: Archetype = {
  id: 'generic',
  signals: /$^/,
  tools: ['Read', 'Edit', 'Write', 'Bash'],
  risky: false,
}

/** Every id a persisted AutomationShape may carry. The classifier derives its
 * known-id set from this list so an added or renamed archetype cannot silently
 * invalidate shapes and push every automation back to the workflow tier. */
export const ARCHETYPE_IDS: readonly string[] = [...ARCHETYPES.map(a => a.id), GENERIC.id]

function countMatches(re: RegExp, text: string): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const global = new RegExp(re.source, flags)
  return text.match(global)?.length ?? 0
}

export function matchArchetype(hint: string | undefined, stepText: string): Archetype {
  if (hint) {
    const hinted = ARCHETYPES.find(a => a.id === hint)
    if (hinted && hinted.signals.test(stepText)) return hinted
  }

  let best: Archetype | null = null
  let bestScore = 0
  for (const archetype of ARCHETYPES) {
    const score = countMatches(archetype.signals, stepText)
    if (score > bestScore) {
      best = archetype
      bestScore = score
    }
  }
  return best ?? GENERIC
}

export function buildSystemPrompt(args: {
  automationName: string
  phaseName: string
  goal: string
  steps: string[]
  risky: boolean
}): string {
  const checklist = args.steps.length
    ? args.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
    : '1. (no specific steps recorded - infer from the goal)'

  return `You are responsible for this phase of an automation generated from repeated Claude Code history.

Automation: ${args.automationName}
Phase: ${args.phaseName}
Goal: ${args.goal}

Observed checklist:
${checklist}

Work directly in the current repository unless the workflow input says otherwise. Reuse existing project conventions. Keep changes scoped to this phase. If a required detail is missing, inspect the repo and make the smallest defensible assumption.

Risk policy: do not perform irreversible external actions unless the workflow has passed an approval gate.`
}

export function buildCompletionCriteria(phaseName: string): string {
  return `The ${phaseName} phase is complete, evidence is summarized, and any files or commands changed by this phase are ready for the next handoff.`
}
