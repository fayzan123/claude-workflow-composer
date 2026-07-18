import { randomUUID } from 'node:crypto'
import { yamlScalar } from '../export/file-writer.js'
import { skillSlug } from '../slugify.js'
import { extractJsonObject } from '../json-extract.js'
import { CWC_FILE_VERSION, type CwcFile, type CwcTrigger } from '../schema.js'
import type { DetectedAutomation } from '../detection/types.js'
import { observedVerificationStep } from '../detection/automation-shape.js'
import type { ClaudeRunner } from '../server/claude-runner.js'
import { externalActionBearingLines, externalActionSignals } from './external-action-risk.js'

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

Authoring standards (the same ones good hand-written skills follow):
- Write for the agent that will execute this, not for a human reader: imperative
  mood, second person, one action per step.
- Include the exact commands, file paths, and names the procedure uses — an agent
  cannot run "the usual checks", it can run \`npm test\`.
- State what done looks like: every procedure ends with a verifiable outcome the
  agent can check, not a vibe.
- Keep the whole body readable in one screen. If a step needs a caveat, put it on
  the step, not in a preamble.
- Never add steps, tools, or side effects the procedure does not actually need.

Be specific to THIS skill's job. Do NOT write generic filler like "You are a helpful assistant that ...". Every instruction must be concrete and directly usable.`
}

export interface GenerateSkillArtifactArgs {
  automation: DetectedAutomation
  tier: 'skill' | 'loop'
  runner: ClaudeRunner
  triggers?: CwcTrigger[]
  model?: string
  signal?: AbortSignal
  onLog?: (message: string) => void
  now?: () => Date
  idFactory?: () => string
}

export interface GeneratedSkillArtifact {
  cwc: CwcFile
  fallbackUsed: boolean
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sentence(value: string): string {
  const clean = oneLine(value).replace(/[.!?]+$/, '')
  return clean ? `${clean}.` : ''
}

function skillDescription(automation: DetectedAutomation): string {
  const description = sentence(automation.description)
  if (/^use when\b/i.test(description)) return description
  if (description) return `Use when this repeated procedure is needed: ${description}`
  return `Use when you need to run the ${oneLine(automation.title) || 'observed'} procedure.`
}

function observedSteps(automation: DetectedAutomation): string[] {
  const steps = automation.steps.map(oneLine).filter(Boolean)
  if (steps.length === 0) {
    throw new Error('This detection has no grounded procedure steps. Run a new history scan and try again.')
  }
  return steps
}

function buildObservedSkillPrompt(spec: SkillSpec): string {
  return `${buildSkillBuildPrompt(spec)}

Grounding requirements:
- Copy every observed step below into the Steps section verbatim, in this order.
- Do not add external side effects, commands, file paths, or requirements that are not in the observed steps.
- Keep the result concise enough to read in one screen.

Observed steps (verbatim):
${spec.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
}

function normalizedCoverageLine(value: string): string {
  let line = value.trim()
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .trim()
  if ((line.startsWith('`') && line.endsWith('`'))
    || (line.startsWith('**') && line.endsWith('**'))
    || (line.startsWith('__') && line.endsWith('__'))) {
    line = line.replace(/^(?:`|\*\*|__)/, '').replace(/(?:`|\*\*|__)$/, '')
  }
  return oneLine(line)
}

function hasOrderedStepCoverage(body: string, steps: string[]): boolean {
  const lines = body.split(/\r?\n/).map(normalizedCoverageLine).filter(Boolean)
  const expected = steps.map(normalizedCoverageLine)
  if (expected.some(step => !step)) return false
  let cursor = 0
  for (const step of expected) {
    const index = lines.indexOf(step, cursor)
    if (index < 0) return false
    cursor = index + 1
  }

  // Reject ambiguous duplicate coverage. Otherwise an early prose echo could
  // satisfy ordering while the actual numbered checklist silently reorders it.
  const frequencies = (values: string[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    return counts
  }
  const expectedCounts = frequencies(expected)
  const lineCounts = frequencies(lines.filter(line => expectedCounts.has(line)))
  return [...expectedCounts].every(([step, count]) => lineCounts.get(step) === count)
}

function normalizedInstructionLine(value: string): string {
  return normalizedCoverageLine(value).replace(/[.!?]+$/, '').toLowerCase()
}

/** External-action-bearing model instructions must be exact observed checklist
 * lines (apart from Markdown list decoration). Matching only the broad signal
 * category would let a model append a different deploy/push/send operation. */
function externalActionsAreTextuallyGrounded(body: string, steps: string[]): boolean {
  const groundedRiskLines = new Set(
    steps
      .filter(step => externalActionSignals(step).size > 0)
      .map(normalizedInstructionLine),
  )
  for (const line of externalActionBearingLines(body)) {
    if (!groundedRiskLines.has(normalizedInstructionLine(line))) return false
  }
  return true
}

function validGeneratedBody(body: string, steps: string[]): boolean {
  const trimmed = body.trim()
  if (!trimmed.startsWith('# ') || trimmed.startsWith('---') || trimmed.length > 100_000) return false
  if (trimmed.includes('<!-- cwc:')) return false
  if (!hasOrderedStepCoverage(trimmed, steps)) return false

  // Model output is untrusted. Exact step coverage is necessary but not sufficient:
  // it must not append a new publish/deploy/message/cloud mutation that the observed
  // checklist never contained. A rejection stays in-tier via the grounded fallback.
  const observedSignals = externalActionSignals(steps.join('\n'))
  for (const signal of externalActionSignals(trimmed)) {
    if (!observedSignals.has(signal)) return false
  }
  return externalActionsAreTextuallyGrounded(trimmed, steps)
}

function fallbackSkillBody(spec: SkillSpec): string {
  return `# Observed procedure

Follow only the observed checklist below. Do not infer additional actions or side effects.

## Steps

${spec.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

## Output

Summarize what was completed, the verification evidence, and anything that still needs attention.`
}

function withLoopStopCondition(body: string, automation: DetectedAutomation): string {
  if (!automation.shape?.hasVerifySignal) return body.trim()
  const command = automation.shape.observedVerifyCommand?.trim()
  const verificationStep = observedVerificationStep(automation)
  const instruction = command
    ? `After each fix round, run this observed verification command:\n\n    ${command}`
    : verificationStep
      ? `After each fix round, repeat this observed verification step: ${oneLine(verificationStep)}`
      : 'After each fix round, repeat the observed verification.'
  return `${body.trim()}

## Verification stop condition

${instruction}

Stop when verification passes. Also stop and report the blocker when two rounds make no progress.`
}

function clonedGeneratedTriggers(triggers: CwcTrigger[]): CwcTrigger[] {
  return triggers.map(trigger => ({
    ...trigger,
    ...(trigger.targets ? { targets: [...trigger.targets] } : {}),
    isolation: 'worktree',
    enabled: false,
  }))
}

function cancelled(signal: AbortSignal | undefined, err: unknown): boolean {
  return signal?.aborted === true || (err instanceof Error && /cancelled/i.test(err.message))
}

/** Generate the smallest procedural CWC artifact. Planner/compiler code is never
 * called here; model failure stays within the requested tier via a deterministic
 * exact-checklist fallback. */
export async function generateSkillArtifact(args: GenerateSkillArtifactArgs): Promise<GeneratedSkillArtifact> {
  const { automation, tier, runner, signal, onLog } = args
  const steps = observedSteps(automation)
  const spec: SkillSpec = {
    name: skillSlug(automation.title),
    description: skillDescription(automation),
    steps,
  }

  let body: string | null = null
  let fallbackUsed = false
  try {
    onLog?.(`Asking Claude to write the ${tier === 'loop' ? 'loop skill' : 'skill'}`)
    const out = await runner(buildObservedSkillPrompt(spec), { model: args.model, signal })
    if (validGeneratedBody(out.result, steps)) body = out.result.trim()
    else {
      fallbackUsed = true
      onLog?.('Skill generation failed grounding or safety checks; using the deterministic checklist fallback.')
    }
  } catch (err) {
    if (cancelled(signal, err)) throw err
    fallbackUsed = true
    onLog?.(`Skill generation failed; using the deterministic checklist fallback: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!body) body = fallbackSkillBody(spec)
  if (tier === 'loop') body = withLoopStopCondition(body, automation)

  const now = (args.now ?? (() => new Date()))().toISOString()
  const id = (args.idFactory ?? randomUUID)()
  const triggers = tier === 'loop' ? clonedGeneratedTriggers(args.triggers ?? []) : []
  const verificationCommand = automation.shape?.observedVerifyCommand
  const verificationStep = observedVerificationStep(automation)
  const cwc: CwcFile = {
    meta: {
      id,
      name: oneLine(automation.title) || 'Generated Skill',
      description: oneLine(automation.description),
      version: CWC_FILE_VERSION,
      created: now,
      updated: now,
      artifactKind: 'skill',
      artifactTier: tier,
      sourceAutomation: {
        id: automation.id,
        steps: [...automation.steps],
        ...(verificationCommand ? { verificationCommand } : {}),
        ...(verificationStep ? { verificationStep } : {}),
      },
      triggers,
    },
    nodes: [{
      id: 'node-skill',
      position: { x: 0, y: 300 },
      exportedSlug: null,
      agent: {
        name: oneLine(automation.title) || 'Generated Skill',
        description: spec.description,
        completionCriteria: 'The observed checklist is complete and the result is summarized with verification evidence.',
        tools: [],
        skills: [],
        systemPrompt: body,
      },
    }],
    edges: [],
  }
  return { cwc, fallbackUsed }
}
