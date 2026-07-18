import { GENERIC, matchArchetype } from '../generation/archetypes.js'
import {
  commandExternalActionSignals,
  externalActionSignals,
  externalMutationToolNames,
  hasExternalAction,
  hasExternalMutationCommand,
  hasHardExternalSignal,
} from '../generation/external-action-risk.js'
import type { AutomationShape, DetectedAutomation, TaskUnit } from './types.js'

const EXPLICIT_PARALLEL_RE = /\b(?:in parallel|parallel(?:ize|ized)?|concurrently|simultaneously|independently|fan[- ]out)\b/i
const TRAILING_INDEPENDENCE_RE = /\b(?:independently|also in parallel)\b/i
const PARALLEL_TOKEN_STOPWORDS = new Set([
  'and', 'the', 'this', 'that', 'these', 'those', 'with', 'from', 'into', 'then',
  'also', 'independently', 'parallel', 'parallelize', 'parallelized', 'concurrently',
  'simultaneously', 'review', 'inspect', 'analyze', 'check', 'verify', 'test',
  'implement', 'build', 'prepare', 'research', 'summarize', 'create', 'update',
])

// These are deliberately command-shaped and anchored. A prose mention such as
// `echo "run npm test"` must not become an executable verification condition.
const VERIFY_COMMAND_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|lint|typecheck|type-check|build|check)\b|npx\s+(?:vitest|jest|eslint|tsc)\b|(?:vitest|jest|eslint|tsc|pytest|ruff|mypy)\b|go\s+test\b|cargo\s+(?:test|check|build)\b|(?:make|mvn|gradle|\.\/gradlew)\s+(?:test|check|build)\b|dotnet\s+(?:test|build)\b)/i

type ShellOperator = '&&' | '||' | ';' | '|' | '|&' | '&'

interface ShellClause {
  text: string
  before: ShellOperator | null
  after: ShellOperator | null
  hasRedirection: boolean
  hasDynamicExpansion: boolean
  hasUnsupportedSyntax: boolean
}

interface ShellScan {
  clauses: ShellClause[]
  malformed: boolean
}

/** A deliberately small shell scanner: enough to isolate observed verifier clauses
 * without pretending to execute or fully parse shell syntax. Operators inside quotes
 * stay literal, while pipelines, backgrounding, redirection, and malformed quoting
 * remain visible so they cannot be persisted as an executable stop condition. */
function scanShellCommand(command: string): ShellScan {
  const clauses: ShellClause[] = []
  let start = 0
  let before: ShellOperator | null = null
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let hasRedirection = false
  let hasDynamicExpansion = false
  let hasUnsupportedSyntax = false
  let malformed = false

  const finish = (at: number, width: number, operator: ShellOperator): void => {
    const text = command.slice(start, at).trim()
    if (!text) malformed = true
    else clauses.push({ text, before, after: operator, hasRedirection, hasDynamicExpansion, hasUnsupportedSyntax })
    start = at + width
    before = operator
    hasRedirection = false
    hasDynamicExpansion = false
    hasUnsupportedSyntax = false
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    const next = command[index + 1]

    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        quote = null
        continue
      }
      if (char === '`' || (char === '$' && next === '(')) hasDynamicExpansion = true
      continue
    }
    if (quote === '`') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '`') quote = null
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      if (char === '`') hasDynamicExpansion = true
      continue
    }
    if (char === '$' && next === '(') {
      hasDynamicExpansion = true
      continue
    }
    // Subshells and brace groups change parsing/scope in ways this intentionally
    // small scanner cannot preserve. Keep them as evidence, never as a command
    // CWC will later execute on its own.
    if (char === '(' || char === ')' || char === '{' || char === '}') {
      hasUnsupportedSyntax = true
      continue
    }

    // Redirection operators are part of the clause rather than boundaries. Skip
    // an adjacent ampersand so `2>&1` is not mistaken for background execution.
    if (char === '<' || char === '>') {
      hasRedirection = true
      if (next === '&') index++
      continue
    }
    if (char === '&' && next === '>') {
      hasRedirection = true
      index++
      continue
    }

    if (char === '&' && next === '&') {
      finish(index, 2, '&&')
      index++
    } else if (char === '|' && next === '|') {
      finish(index, 2, '||')
      index++
    } else if (char === '|' && next === '&') {
      finish(index, 2, '|&')
      index++
    } else if (char === '|') {
      finish(index, 1, '|')
    } else if (char === '&') {
      finish(index, 1, '&')
    } else if (char === ';') {
      finish(index, 1, ';')
    } else if (char === '\r' || char === '\n') {
      const width = char === '\r' && next === '\n' ? 2 : 1
      finish(index, width, ';')
      if (width === 2) index++
    }
  }

  if (quote !== null || escaped) malformed = true
  const text = command.slice(start).trim()
  if (text) clauses.push({ text, before, after: null, hasRedirection, hasDynamicExpansion, hasUnsupportedSyntax })
  else if (before !== null) malformed = true
  return { clauses, malformed }
}

function shellWords(value: string): string[] | null {
  const words: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  const flush = (): void => {
    if (current) {
      words.push(current)
      current = ''
    }
  }
  for (const char of value) {
    if (quote === "'") {
      current += char
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      current += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = null
      continue
    }
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      current += char
      escaped = true
    } else if (char === "'" || char === '"') {
      current += char
      quote = char
    } else if (/\s/.test(char)) {
      flush()
    } else {
      current += char
    }
  }
  if (quote !== null || escaped) return null
  flush()
  return words
}

function looksLikeCd(clause: ShellClause): boolean {
  return /^cd(?:\s|$)/.test(clause.text)
}

function isSafeCd(clause: ShellClause): boolean {
  if (!looksLikeCd(clause) || clause.hasRedirection || clause.hasDynamicExpansion || clause.hasUnsupportedSyntax) return false
  const words = shellWords(clause.text)
  if (!words) return false
  const pathIndex = words[1] === '--' ? 2 : 1
  return words[0] === 'cd' && words.length === pathIndex + 1 && words[pathIndex] !== '-'
}

function unsafeVerifierAdjacency(operator: ShellOperator | null): boolean {
  return operator === '|' || operator === '|&' || operator === '&'
}

/** Builtins and assignment-only clauses can change the cwd, exported environment,
 * shell options, or interpretation of a later verifier without spawning a child.
 * If they occur in the same && chain and cannot be retained as an adjacent safe cd,
 * dropping them would change what the persisted verifier means. */
function affectsShellContext(clause: ShellClause): boolean {
  const words = shellWords(clause.text)
  const assignmentOnly = words !== null && words.length > 0
    && words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return looksLikeCd(clause)
    || /^(?:pushd|popd|source|\.\s|export|unset|set|setopt|shopt|umask|ulimit|alias|unalias|eval)(?:\s|$)/.test(clause.text)
    || assignmentOnly
}

function safeVerificationCommands(unit: TaskUnit): string[] {
  const commands: string[] = []
  for (const raw of unit.commands) {
    const scan = scanShellCommand(raw)
    if (scan.malformed) continue
    for (let index = 0; index < scan.clauses.length; index++) {
      const clause = scan.clauses[index]
      if (!VERIFY_COMMAND_RE.test(clause.text)
        || clause.hasRedirection
        || clause.hasDynamicExpansion
        || clause.hasUnsupportedSyntax
        || unsafeVerifierAdjacency(clause.before)
        || unsafeVerifierAdjacency(clause.after)) continue

      const prefixes: string[] = []
      let prefixIndex = index - 1
      let unsafeCwd = false
      while (prefixIndex >= 0 && looksLikeCd(scan.clauses[prefixIndex])) {
        const prefix = scan.clauses[prefixIndex]
        const connected = scan.clauses[prefixIndex + 1].before === '&&' && prefix.after === '&&'
        if (!connected || !isSafeCd(prefix)) {
          unsafeCwd = true
          break
        }
        prefixes.unshift(prefix.text)
        prefixIndex--
      }
      // Continue through the surrounding && chain to catch an earlier cwd or
      // environment mutation whose effect would otherwise be silently omitted.
      for (let contextIndex = prefixIndex; !unsafeCwd && contextIndex >= 0; contextIndex--) {
        const nextClause = scan.clauses[contextIndex + 1]
        if (nextClause.before !== '&&' || scan.clauses[contextIndex].after !== '&&') break
        if (affectsShellContext(scan.clauses[contextIndex])) unsafeCwd = true
      }
      if (unsafeCwd) continue
      commands.push([...prefixes, clause.text].join(' && '))
    }
  }
  return commands
}

function hasVerificationCommandSignal(unit: TaskUnit): boolean {
  return unit.commands.some(raw => {
    const scan = scanShellCommand(raw)
    return scan.clauses.some(clause => VERIFY_COMMAND_RE.test(clause.text))
      || VERIFY_COMMAND_RE.test(raw.trim())
  })
}

function commandKey(command: string): string {
  return command.trim()
}

function mostFrequentCommand(commands: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const command of commands) {
    const key = commandKey(command)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))[0]?.[0]
}

function repeatedVerificationCommands(unit: TaskUnit): string[] {
  const commands = safeVerificationCommands(unit)
  const counts = new Map<string, number>()
  for (const command of commands) {
    const key = commandKey(command)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return commands.filter(command => (counts.get(commandKey(command)) ?? 0) >= 2)
}

function riskSegments(command: string): string[] {
  const scan = scanShellCommand(command)
  return scan.clauses.length > 0 ? scan.clauses.map(clause => clause.text) : [command.trim()]
}

const SLASH_COMMAND_TAG_RE = /<command-name>\/?([A-Za-z0-9][\w:-]*)<\/command-name>/
const SLASH_COMMAND_LEAD_RE = /^\s*\/([A-Za-z0-9][\w:-]*)(?=\s|$)/

function unitSlashCommand(unit: TaskUnit): string | undefined {
  const match = SLASH_COMMAND_TAG_RE.exec(unit.promptText) ?? SLASH_COMMAND_LEAD_RE.exec(unit.promptText)
  if (match) return match[1].toLowerCase()
  // A natural-language prompt that Claude fulfilled by invoking an installed
  // skill/command is equally "already automated" evidence.
  const invoked = unit.invokedCommands?.[0]
  return invoked ? invoked.toLowerCase() : undefined
}

/** The single slash command that drives a strict majority of the evidence units,
 * if any. Such a repetition is already automated by an installed command, so the
 * classifier suggests a standing rule pointing at it instead of a wrapper artifact. */
function majoritySlashCommand(units: TaskUnit[]): string | undefined {
  if (units.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const unit of units) {
    const command = unitSlashCommand(unit)
    if (command) counts.set(command, (counts.get(command) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return top && top[1] * 2 > units.length ? top[0] : undefined
}

function subjectTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => token.length > 1 && !PARALLEL_TOKEN_STOPWORDS.has(token)))
}

function contiguousSameArchetypeRuns(indexes: number[], archetypes: string[]): number[][] {
  const runs: number[][] = []
  for (const index of indexes) {
    const current = runs[runs.length - 1]
    if (current
      && index === current[current.length - 1] + 1
      && archetypes[index] !== GENERIC.id
      && archetypes[index] === archetypes[current[0]]) current.push(index)
    else runs.push([index])
  }
  return runs.filter(run => run.length >= 2 && archetypes[run[0]] !== GENERIC.id)
}

function explicitStepCohort(steps: string[], archetypes: string[]): number[] | null {
  const candidates: number[][] = []
  for (let index = 0; index < steps.length; index++) {
    if (!EXPLICIT_PARALLEL_RE.test(steps[index])) continue
    const prefersPrevious = TRAILING_INDEPENDENCE_RE.test(steps[index])
    const adjacent = prefersPrevious
      ? index - 1
      : index + 1 < steps.length && archetypes[index + 1] === archetypes[index]
        ? index + 1
        : index - 1
    if (adjacent < 0 || adjacent >= steps.length
      || archetypes[index] === GENERIC.id
      || archetypes[adjacent] !== archetypes[index]) continue
    candidates.push([Math.min(index, adjacent), Math.max(index, adjacent)])
  }
  if (candidates.length === 0) return null

  const merged = new Set(candidates[0])
  for (const candidate of candidates.slice(1)) {
    if (!candidate.some(index => merged.has(index))) return null
    for (const index of candidate) merged.add(index)
  }
  return [...merged].sort((a, b) => a - b)
}

function promptGroundedCohort(steps: string[], archetypes: string[], units: TaskUnit[]): number[] | null {
  const candidates: number[][] = []
  for (const unit of units) {
    if (!EXPLICIT_PARALLEL_RE.test(unit.promptText)) continue
    const prompt = subjectTokens(unit.promptText)
    if (prompt.size === 0) continue
    const grounded = steps
      .map((step, index) => {
        const subjects = subjectTokens(step)
        return subjects.size > 0 && [...subjects].some(token => prompt.has(token)) ? index : -1
      })
      .filter(index => index >= 0)
    candidates.push(...contiguousSameArchetypeRuns(grounded, archetypes))
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length || a[0] - b[0])
  if (candidates[1]?.length === candidates[0].length
    && candidates[1].some((index, offset) => index !== candidates[0][offset])) return null
  return candidates[0]
}

function independentStepIndexes(steps: string[], archetypes: string[], units: TaskUnit[]): number[] | null {
  if (steps.length < 2) return null
  const explicit = explicitStepCohort(steps, archetypes)
  const promptGrounded = promptGroundedCohort(steps, archetypes, units)
  if (explicit && promptGrounded) {
    if (!explicit.every(index => promptGrounded.includes(index))) return null
    return promptGrounded
  }
  return explicit ?? promptGrounded
}

/** Validate the persisted fan-out coordinates before generation. Older or
 * malformed records may still classify conservatively as workflows, but they do
 * not gain execution-changing parallel edges without exact grounded indexes. */
export function validatedIndependentStepIndexes(
  shape: AutomationShape | undefined,
  stepCount: number,
): number[] | null {
  if (!shape || !Number.isInteger(shape.independentStepGroups) || shape.independentStepGroups < 1) return null
  const indexes = shape.independentStepIndexes
  if (shape.independentStepGroups === 1) return indexes === undefined || indexes.length === 0 ? [] : null
  if (!Array.isArray(indexes) || indexes.length !== shape.independentStepGroups) return null
  if (indexes.some((index, offset) => !Number.isInteger(index)
    || index < 0 || index >= stepCount
    || (offset > 0 && index !== indexes[offset - 1] + 1))) return null
  return [...indexes]
}

export function deriveAutomationShape(
  automation: Pick<DetectedAutomation, 'steps' | 'suggestedTrigger' | 'evidence'>,
  units: TaskUnit[],
): AutomationShape {
  const archetypes = automation.steps.map(step => matchArchetype(undefined, step))
  const stepArchetypes = archetypes.map(archetype => archetype.id)
  const parallelIndexes = independentStepIndexes(automation.steps, stepArchetypes, units)
  const verifyCommands = units.flatMap(safeVerificationCommands)
  const repeatedVerifyCommands = units.flatMap(repeatedVerificationCommands)
  const hasRetryPattern = repeatedVerifyCommands.length > 0
  const observedVerifyCommand = mostFrequentCommand(hasRetryPattern ? repeatedVerifyCommands : verifyCommands)
  const hasCommandRisk = units.some(unit =>
    unit.commands.flatMap(riskSegments).some(segment =>
      hasExternalMutationCommand(segment) || matchArchetype(undefined, segment).risky
    )
  )
  const hasGroundedPromptRisk = units.some(unit => hasExternalAction(unit.promptText))
  // Hard risk = irreversible/outward-facing signals only. Soft VCS activity
  // (commit/push/PR) still marks hasRiskyStep but not this flag, so the
  // classifier can keep daily collaboration procedures on the skill/loop tiers.
  // A hard signal in the automation's own steps is absolute; hard signals seen
  // only in unit evidence must characterize the repetition — a strict majority of
  // its units — so overlapping release/connector sessions cannot harden an
  // otherwise-soft repetition no matter how much evidence it accumulates.
  const unitHasHardEvidence = (unit: TaskUnit): boolean =>
    unit.commands.flatMap(riskSegments).some(segment =>
      hasHardExternalSignal(commandExternalActionSignals(segment)))
    || hasHardExternalSignal(externalActionSignals(unit.promptText))
    || externalMutationToolNames(unit.tools).length > 0
  const hardEvidenceUnits = units.filter(unitHasHardEvidence).length
  const hasCorroboratedHardUnitRisk = hardEvidenceUnits * 2 > units.length
  const hasHardStepRisk = automation.steps.some(step => hasHardExternalSignal(externalActionSignals(step)))
  const mutatingTools = externalMutationToolNames(units.flatMap(unit => unit.tools))
  // Agent frontmatter renders tool names as a comma-separated allowlist. Preserve
  // normal Claude/MCP identifiers exactly, but never let a forged transcript name
  // inject another YAML entry or an unbounded value.
  const observedMutatingTools = mutatingTools
    .filter(tool => tool.length <= 200 && /^[A-Za-z0-9_.:/-]+$/.test(tool))
    .slice(0, 32)
  const hasToolRisk = mutatingTools.length > 0
  const distinctArchetypes = new Set(stepArchetypes.filter(id => id !== GENERIC.id)).size

  const hasRiskyStep = archetypes.some(archetype => archetype.risky)
    || automation.steps.some(hasExternalAction)
    || hasGroundedPromptRisk
    || hasToolRisk
    || hasCommandRisk
  const hasHardRiskyStep = hasRiskyStep
    && (hasHardStepRisk || hasCorroboratedHardUnitRisk)
  const invokedSlashCommand = majoritySlashCommand(units)

  return {
    stepArchetypes,
    distinctArchetypes,
    hasToolActivity: units.some(unit => unit.tools.length > 0 || unit.commands.length > 0),
    hasVerifySignal: archetypes.some(archetype => archetype.id === 'verify') || units.some(hasVerificationCommandSignal),
    hasRetryPattern,
    hasRiskyStep,
    hasHardRiskyStep,
    ...(invokedSlashCommand ? { invokedSlashCommand } : {}),
    independentStepGroups: parallelIndexes?.length ?? 1,
    ...(parallelIndexes ? { independentStepIndexes: parallelIndexes } : {}),
    recurring: automation.suggestedTrigger.kind === 'schedule' || Boolean(automation.evidence.timing),
    ...(observedMutatingTools.length > 0 ? { observedMutatingTools } : {}),
    ...(observedVerifyCommand ? { observedVerifyCommand } : {}),
  }
}

function normalizedPrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function promptTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** Choose one observed prompt rather than asking a model to invent a standing rule.
 * Exact repeats win; otherwise the token medoid is stable across input ordering. */
export function deriveRuleSuggestion(units: TaskUnit[]): string | undefined {
  const prompts = units.map(unit => normalizedPrompt(unit.promptText)).filter(Boolean)
  if (prompts.length === 0) return undefined
  const candidates = new Map<string, { value: string; count: number; tokens: Set<string> }>()
  for (const prompt of prompts) {
    const key = prompt.toLocaleLowerCase()
    const current = candidates.get(key)
    if (current) current.count++
    else candidates.set(key, { value: prompt, count: 1, tokens: promptTokens(prompt) })
  }
  const all = [...candidates.values()]
  all.sort((a, b) => {
    const aSimilarity = all.reduce((sum, candidate) => sum + jaccard(a.tokens, candidate.tokens), 0)
    const bSimilarity = all.reduce((sum, candidate) => sum + jaccard(b.tokens, candidate.tokens), 0)
    return b.count - a.count
      || bSimilarity - aSimilarity
      || a.value.length - b.value.length
      || a.value.localeCompare(b.value)
  })
  return all[0]?.value
}

/** Retain the grounded verification instruction for loop semantics even when the
 * transcript did not contain a command safe enough to execute as a stop condition. */
export function observedVerificationStep(
  automation: Pick<DetectedAutomation, 'steps' | 'shape'>,
): string | undefined {
  const index = automation.shape?.stepArchetypes.findIndex(archetype => archetype === 'verify') ?? -1
  return index >= 0 ? automation.steps[index] : undefined
}
