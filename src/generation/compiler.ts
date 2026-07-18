import { randomUUID } from 'node:crypto'
import type { DetectedAutomation } from '../detection/types.js'
import { CWC_FILE_VERSION, type CwcEdge, type CwcFile, type CwcNode, type CwcTrigger } from '../schema.js'
import type { CapabilityCard, CatalogAgent, CatalogSkill } from './workflow-generator.js'
import { buildCompletionCriteria, buildSystemPrompt, GENERIC, matchArchetype } from './archetypes.js'
import { fallbackPlan } from './fallback-plan.js'
import type { PlanPhase, WorkflowPlan } from './plan-schema.js'
import { validatePlan } from './plan-schema.js'
import { resolveReuse as resolveReuseGate } from './reuse-gate.js'
import { scanRisk as scanRiskDefault } from './risk-scanner.js'
import { agentSlug } from '../slugify.js'
import { observedVerificationStep, validatedIndependentStepIndexes } from '../detection/automation-shape.js'

export type ReuseDecision =
  | { attach: false; reason?: string }
  | { attach: true; kind: 'skill' | 'agent'; slug: string }

export interface GenerationCatalog {
  skills: CatalogSkill[]
  agents: CatalogAgent[]
  cards: CapabilityCard[]
}

export interface CompilerDeps {
  resolveReuse?: (phase: PlanPhase, automation: DetectedAutomation, catalog: GenerationCatalog) => ReuseDecision
  scanRisk?: (phase: PlanPhase, automation: DetectedAutomation) => boolean
}

export interface CompileInput {
  automation: DetectedAutomation
  plan: unknown
  catalog: GenerationCatalog
  triggers: CwcTrigger[]
  onLog?: (message: string) => void
}

const X_STEP = 350
const Y_BASE = 300

function defaultDeps(plan: WorkflowPlan): CompilerDeps {
  return {
    resolveReuse: (phase, automation, catalog) => resolveReuseGate(phase, automation, catalog, plan),
    scanRisk: scanRiskDefault,
  }
}

function titleCase(value: string): string {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const titled = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
  return titled.slice(0, 60) || 'Phase'
}

function phaseSteps(phase: PlanPhase, automation: DetectedAutomation): string[] {
  const steps = phase.stepIndexes
    .map(i => automation.steps[i])
    .filter((step): step is string => typeof step === 'string' && step.length > 0)
  return steps.length > 0 ? steps : [automation.title]
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base
  let suffix = 2
  while (used.has(name)) {
    name = `${base} (${suffix++})`
  }
  used.add(name)
  return name
}

function previousNodeName(nodes: CwcNode[], id: string): string {
  return nodes.find(node => node.id === id)?.agent.name ?? 'Previous phase'
}

function makeHandoffTrigger(nodes: CwcNode[], from: string): string {
  return `${previousNodeName(nodes, from)} is complete and has handed off the required context.`
}

const TOOL_NAMESPACE_TOKENS = new Set(['app', 'connector', 'mcp', 'tool'])

function toolTokens(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(token => token.length > 2 && !TOOL_NAMESPACE_TOKENS.has(token))
}

function safeObservedMutatingTools(automation: DetectedAutomation): string[] {
  const tools = automation.shape?.observedMutatingTools ?? []
  return [...new Set(tools)]
    .filter(tool => tool.length <= 200 && /^[A-Za-z0-9_.:/-]+$/.test(tool))
    .slice(0, 32)
}

/** Map each observed connector to one independently gated phase. Strong textual
 * overlap wins. Ambiguous tools are delayed to the last already-risky phase so
 * an early approval cannot expose a capability intended for a later action. */
function mutatingToolsByPhase(
  plan: WorkflowPlan,
  automation: DetectedAutomation,
  basePhaseRisks: boolean[],
): string[][] {
  const result = plan.phases.map(() => [] as string[])
  const tools = safeObservedMutatingTools(automation)
  if (tools.length === 0 || result.length === 0) return result
  const phaseTokenSets = plan.phases.map(phase =>
    new Set(toolTokens(phaseSteps(phase, automation).join(' '))))
  const lastRiskyPhase = basePhaseRisks.reduce((last, risky, index) => risky ? index : last, -1)

  for (const tool of tools) {
    const tokens = toolTokens(tool)
    let bestIndex = -1
    let bestScore = 0
    for (let index = 0; index < phaseTokenSets.length; index++) {
      const score = tokens.reduce((total, token) => total + (phaseTokenSets[index].has(token) ? 1 : 0), 0)
      // Resolve ties toward the later phase. That keeps the capability behind all
      // earlier linear approval boundaries when the evidence is ambiguous.
      if (score >= bestScore && score > 0) {
        bestIndex = index
        bestScore = score
      }
    }
    const target = bestScore >= 2 ? bestIndex : (lastRiskyPhase >= 0 ? lastRiskyPhase : 0)
    result[target].push(tool)
  }
  return result
}

function connectorToolPolicy(tools: readonly string[]): string {
  if (tools.length === 0) return ''
  return `\n\nUse only the observed connector tool${tools.length === 1 ? '' : 's'} ${tools.map(tool => `\`${tool}\``).join(', ')} for the approved external actions in this phase. Do not use ${tools.length === 1 ? 'it' : 'them'} for actions assigned to another phase.`
}

function hasGroundedParallelCohort(plan: WorkflowPlan, requiredIndexes: number[]): boolean {
  for (let start = 0; start < plan.phases.length;) {
    if (plan.phases[start].dispatch !== 'parallel') {
      start++
      continue
    }
    let end = start + 1
    while (end < plan.phases.length && plan.phases[end].dispatch === 'parallel') end++
    const cohort = plan.phases.slice(start, end)
    const indexes = cohort.flatMap(phase => phase.stepIndexes).sort((a, b) => a - b)
    if (cohort.length === requiredIndexes.length
      && cohort.every(phase => phase.stepIndexes.length === 1)
      && indexes.length === requiredIndexes.length
      && indexes.every((index, offset) => index === requiredIndexes[offset])) return true
    start = end
  }
  return false
}

export function compile(input: CompileInput, deps?: CompilerDeps): CwcFile {
  try {
    return compileInner(input, deps)
  } catch (err) {
    input.onLog?.(`Compiler recovered from an unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    return compileInner({ ...input, plan: fallbackPlan(input.automation) }, {
      resolveReuse: () => ({ attach: false, reason: 'compiler recovery fallback' }),
      scanRisk: scanRiskDefault,
    })
  }
}

function compileInner(input: CompileInput, deps?: CompilerDeps): CwcFile {
  const { automation, catalog } = input
  const validatedPlan = validatePlan(input.plan, automation.steps.length)
  const groundedParallelIndexes = validatedIndependentStepIndexes(automation.shape, automation.steps.length)
  const requiredParallelSize = groundedParallelIndexes && groundedParallelIndexes.length >= 2
    ? groundedParallelIndexes.length
    : 1
  const requiresParallelCohort = requiredParallelSize >= 2
  const hasUnsupportedConditional = validatedPlan?.phases.some(phase => phase.dispatch === 'conditional') ?? false
  // No persisted shape means no grounded sibling evidence, so planner parallelism
  // is ungrounded for legacy automations exactly as it is for linear shapes.
  const hasUngroundedParallel = !requiresParallelCohort
    && (validatedPlan?.phases.some(phase => phase.dispatch === 'parallel') ?? false)
  const plan = validatedPlan
    && !hasUnsupportedConditional
    && !hasUngroundedParallel
    && (!requiresParallelCohort || hasGroundedParallelCohort(validatedPlan, groundedParallelIndexes!))
    ? validatedPlan
    : fallbackPlan(automation)
  if (validatedPlan && requiresParallelCohort && plan !== validatedPlan) {
    input.onLog?.('Planner output omitted the observed parallel fan-out; using the deterministic parallel fallback plan.')
  } else if (validatedPlan && hasUnsupportedConditional) {
    input.onLog?.('Planner output requested conditional dispatch without grounded branch conditions; using the deterministic fallback plan.')
  } else if (validatedPlan && hasUngroundedParallel) {
    input.onLog?.('Planner output invented parallel dispatch without grounded sibling evidence; using the deterministic fallback plan.')
  }
  const builtDeps = deps ?? defaultDeps(plan)
  const resolveReuse = builtDeps.resolveReuse ?? defaultDeps(plan).resolveReuse!
  const scanRisk = builtDeps.scanRisk ?? scanRiskDefault
  const usesDefaultRiskPolicy = deps?.scanRisk === undefined || deps.scanRisk === scanRiskDefault

  const basePhaseRisks = plan.phases.map(phase => {
    const steps = phaseSteps(phase, automation)
    const stepArchetype = matchArchetype(phase.archetypeHint, steps.join('\n'))
    return scanRisk(phase, automation) || (usesDefaultRiskPolicy && stepArchetype.risky)
  })
  const phaseMutatingTools = mutatingToolsByPhase(plan, automation, basePhaseRisks)
  const phaseRisks = basePhaseRisks.map((risky, index) =>
    risky || phaseMutatingTools[index].length > 0)
  // Command/prompt evidence can prove that the automation is risky even when the
  // analysis model summarizes every step blandly. In that case, guard the whole
  // workflow at entry rather than silently compiling a gate-free safety workflow.
  const guardWorkflowAtEntry = usesDefaultRiskPolicy
    && automation.shape?.hasRiskyStep === true
    && !phaseRisks.some(Boolean)

  const now = new Date().toISOString()
  const nodes: CwcNode[] = []
  const edges: CwcEdge[] = []
  const usedNames = new Set<string>()
  let x = 0
  let frontier: string[] = []
  let edgeSeq = 1

  const addEdge = (from: string, to: string | null, trigger: string, terminalType?: CwcEdge['terminalType']): void => {
    const edge: CwcEdge = { id: `edge-${edgeSeq++}`, from, to, trigger }
    if (terminalType) edge.terminalType = terminalType
    edges.push(edge)
  }

  for (let groupStart = 0; groupStart < plan.phases.length;) {
    const parallel = plan.phases[groupStart].dispatch === 'parallel'
    let groupEnd = groupStart + 1
    if (parallel) {
      while (groupEnd < plan.phases.length && plan.phases[groupEnd].dispatch === 'parallel') groupEnd++
    }
    const groupSize = groupEnd - groupStart
    let incoming = [...frontier]
    const branchEnds: string[] = []
    let maxColumns = 1

    // One approval session must guard the whole fan-out. Independent gate nodes
    // cannot be paused/resumed as separate sessions by one orchestrator. A shared
    // boundary also prevents a safe-looking sibling from starting alongside an
    // entry branch whose risk was visible only in transcript evidence.
    const sharedParallelRisk = parallel && (
      (guardWorkflowAtEntry && groupStart === 0)
      || phaseRisks.slice(groupStart, groupEnd).some(Boolean)
    )
    if (sharedParallelRisk) {
      let prefixPrevious: string | null = null
      if (incoming.length === 0) {
        const preflightId = `node-preflight-parallel-${groupStart + 1}`
        const preflightName = uniqueName('Preflight Review', usedNames)
        const intents = plan.phases.slice(groupStart, groupEnd).map(phase => phase.intent).join('; ')
        nodes.push({
          id: preflightId,
          position: { x, y: Y_BASE },
          exportedSlug: null,
          startTrigger: `Start when this repeated work is needed: ${automation.suggestedTrigger.label}`,
          agent: {
            name: preflightName,
            description: 'Prepare one approval context for the upcoming parallel actions.',
            completionCriteria: 'The reviewer has the targets, prerequisites, current state, requested external actions, and material risks needed for approval.',
            color: 'blue',
            tools: ['Read'],
            skills: [],
            systemPrompt: `Perform a read-only preflight for these upcoming parallel phases: ${intents}.

Inspect relevant repository files and the workflow input. Summarize every target, prerequisite, current state, exact irreversible external action requested, and material risk for the reviewer.

Do not publish, deploy, push, send, or mutate files or external systems. Do not run shell commands. Stop after preparing approval context.`,
          },
        })
        prefixPrevious = preflightId
        x += X_STEP
      }

      const gateId = `node-gate-parallel-${groupStart + 1}`
      const gateName = uniqueName('Approval Gate', usedNames)
      nodes.push({
        id: gateId,
        position: { x, y: Y_BASE },
        exportedSlug: null,
        nodeType: 'gate',
        agent: {
          name: gateName,
          description: 'Approve the complete parallel fan-out before any high-risk external or production-impacting branch starts.',
          completionCriteria: '',
          tools: [],
          skills: [],
          systemPrompt: '',
        },
      })
      if (prefixPrevious) addEdge(prefixPrevious, gateId, makeHandoffTrigger(nodes, prefixPrevious))
      else for (const from of incoming) addEdge(from, gateId, makeHandoffTrigger(nodes, from))
      incoming = [gateId]
      x += X_STEP
    }

    for (let phaseIndex = groupStart; phaseIndex < groupEnd; phaseIndex++) {
      const phase = plan.phases[phaseIndex]
      const steps = phaseSteps(phase, automation)
      const stepText = steps.join('\n')
      const requestedDecision = resolveReuse(phase, automation, catalog)
      // Reference agents have an immutable tool contract that CWC cannot safely
      // widen. Compile this phase as bespoke when exact observed connector access
      // is required; skill reuse remains valid because its wrapper agent is bespoke.
      const decision: ReuseDecision = phaseMutatingTools[phaseIndex].length > 0
        && requestedDecision.attach && requestedDecision.kind === 'agent'
        ? { attach: false, reason: 'observed connector tools require an explicit bespoke-agent allowlist' }
        : requestedDecision
      if (phase.reuse && !decision.attach) {
        input.onLog?.(`Reuse ${phase.reuse.slug} demoted to bespoke: ${decision.reason ?? 'failed shapeCheck or capability threshold'}`)
      }

      const stepArchetype = matchArchetype(phase.archetypeHint, stepText)
      const archetype = decision.attach ? GENERIC : stepArchetype
      // An ungrounded entry risk protects every branch in an entry fan-out; no
      // sibling may start alongside the gated branch and bypass that boundary.
      const risky = phaseRisks[phaseIndex] || (guardWorkflowAtEntry && groupStart === 0)
      const observedTools = phaseMutatingTools[phaseIndex]
      const toolPolicy = connectorToolPolicy(observedTools)
      const branchIndex = phaseIndex - groupStart
      const y = groupSize === 1
        ? Y_BASE
        : Y_BASE + Math.round((branchIndex - (groupSize - 1) / 2) * 180)
      let branchX = x
      let columns = 0
      let chainStart: string | null = null
      let chainPrevious: string | null = null

      // Entry gates are not runnable: approval resumes the preceding agent session.
      // Give every risky entry branch a read-only preflight before its gate.
      const needsOwnGate = risky && !sharedParallelRisk
      if (needsOwnGate && incoming.length === 0) {
        const preflightId = `node-preflight-${phase.id}`
        const preflightName = uniqueName('Preflight Review', usedNames)
        nodes.push({
          id: preflightId,
          position: { x: branchX, y },
          exportedSlug: null,
          startTrigger: `Start when this repeated work is needed: ${automation.suggestedTrigger.label}`,
          agent: {
            name: preflightName,
            description: `Prepare approval context before ${phase.intent}.`,
            completionCriteria: 'The reviewer has the target, prerequisites, current state, requested external action, and material risks needed for approval.',
            color: 'blue',
            tools: ['Read'],
            skills: [],
            systemPrompt: `Perform a read-only preflight for the upcoming phase: ${phase.intent}.

Inspect relevant repository files and the workflow input. Summarize the target, prerequisites, current state, exact irreversible external action requested, and material risks for the reviewer.

Do not publish, deploy, push, send, or mutate files or external systems. Do not run shell commands. Stop after preparing approval context.`,
          },
        })
        chainStart = preflightId
        chainPrevious = preflightId
        branchX += X_STEP
        columns++
      }

      if (needsOwnGate) {
        const gateId = `node-gate-${phase.id}`
        const gateName = uniqueName('Approval Gate', usedNames)
        nodes.push({
          id: gateId,
          position: { x: branchX, y },
          exportedSlug: null,
          nodeType: 'gate',
          agent: {
            name: gateName,
            description: 'Pause for human approval before high-risk external or production-impacting actions.',
            completionCriteria: '',
            tools: [],
            skills: [],
            systemPrompt: '',
          },
        })
        if (chainPrevious) addEdge(chainPrevious, gateId, makeHandoffTrigger(nodes, chainPrevious))
        chainStart ??= gateId
        chainPrevious = gateId
        branchX += X_STEP
        columns++
      }

      const phaseName = uniqueName(titleCase(phase.intent), usedNames)
      const nodeId = `node-${phase.id}`
      let node: CwcNode

      if (decision.attach && decision.kind === 'agent') {
        node = {
          id: nodeId,
          position: { x: branchX, y },
          exportedSlug: null,
          agentRef: decision.slug,
          agent: {
            name: phaseName,
            description: phase.intent,
            completionCriteria: '',
            color: 'blue',
            tools: [],
            skills: [],
            systemPrompt: '',
          },
        }
      } else if (decision.attach && decision.kind === 'skill') {
        node = {
          id: nodeId,
          position: { x: branchX, y },
          exportedSlug: null,
          agent: {
            name: phaseName,
            description: phase.intent,
            completionCriteria: buildCompletionCriteria(phaseName),
            color: 'blue',
            tools: [...new Set(['Bash', 'Read', ...observedTools])],
            skills: [decision.slug],
            systemPrompt: `Run the /${decision.slug} skill to ${phase.intent}.${toolPolicy}`,
          },
        }
      } else {
        node = {
          id: nodeId,
          position: { x: branchX, y },
          exportedSlug: null,
          agent: {
            name: phaseName,
            description: phase.intent,
            completionCriteria: buildCompletionCriteria(phaseName),
            color: 'blue',
            tools: [...new Set([...archetype.tools, ...observedTools])],
            skills: [],
            systemPrompt: `${buildSystemPrompt({
              automationName: automation.title,
              phaseName,
              goal: phase.intent,
              steps,
              risky,
            })}${toolPolicy}`,
          },
        }
      }

      if (incoming.length === 0 && !chainStart) {
        node.startTrigger = `Start when this repeated work is needed: ${automation.suggestedTrigger.label}`
      }
      nodes.push(node)
      chainStart ??= nodeId
      if (chainPrevious) addEdge(chainPrevious, nodeId, makeHandoffTrigger(nodes, chainPrevious))
      for (const from of incoming) addEdge(from, chainStart, makeHandoffTrigger(nodes, from))
      branchEnds.push(nodeId)
      columns++
      maxColumns = Math.max(maxColumns, columns)
    }

    if (parallel && incoming.length === 1) {
      const source = nodes.find(node => node.id === incoming[0])
      if (source) source.dispatchMode = 'parallel'
    }
    frontier = branchEnds
    x += maxColumns * X_STEP
    groupStart = groupEnd
  }

  for (const terminalId of frontier) {
    addEdge(
      terminalId,
      null,
      frontier.length === 1
        ? `${previousNodeName(nodes, terminalId)} completes the workflow.`
        : `${previousNodeName(nodes, terminalId)} completes its workflow branch.`,
      'complete',
    )
  }

  return selfHeal({
    meta: {
      id: randomUUID(),
      name: plan.name || automation.title,
      description: plan.description || automation.description,
      version: CWC_FILE_VERSION,
      created: now,
      updated: now,
      artifactKind: 'workflow',
      artifactTier: 'workflow',
      sourceAutomation: {
        id: automation.id,
        steps: [...automation.steps],
        ...(automation.shape?.observedVerifyCommand
          ? { verificationCommand: automation.shape.observedVerifyCommand }
          : {}),
        ...(observedVerificationStep(automation)
          ? { verificationStep: observedVerificationStep(automation) }
          : {}),
      },
      triggers: [...input.triggers],
    },
    nodes,
    edges,
  })
}

function selfHeal(cwc: CwcFile): CwcFile {
  const ids = new Set(cwc.nodes.map(node => node.id))
  cwc.edges = cwc.edges.filter(edge => ids.has(edge.from) && (edge.to === null || ids.has(edge.to)))

  const seen = new Set<string>()
  for (const node of cwc.nodes) {
    node.exportedSlug = null
    const base = node.agent.name || 'Phase'
    let name = base
    let suffix = 2
    const keyFor = (candidate: string) => node.agentRef || node.nodeType === 'gate' ? candidate : agentSlug(candidate)
    while (seen.has(keyFor(name))) name = `${base} (${suffix++})`
    node.agent.name = name
    seen.add(keyFor(name))
  }

  return cwc
}
