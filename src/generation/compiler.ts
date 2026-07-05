import { randomUUID } from 'node:crypto'
import type { DetectedAutomation } from '../detection/types.js'
import type { CwcEdge, CwcFile, CwcNode, CwcTrigger } from '../schema.js'
import type { CapabilityCard, CatalogAgent, CatalogSkill } from './workflow-generator.js'
import { buildCompletionCriteria, buildSystemPrompt, GENERIC, matchArchetype } from './archetypes.js'
import { fallbackPlan } from './fallback-plan.js'
import type { PlanPhase, WorkflowPlan } from './plan-schema.js'
import { validatePlan } from './plan-schema.js'
import { resolveReuse as resolveReuseGate } from './reuse-gate.js'
import { scanRisk as scanRiskDefault } from './risk-scanner.js'
import { agentSlug } from '../slugify.js'

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
  const plan = validatePlan(input.plan, automation.steps.length) ?? fallbackPlan(automation)
  const builtDeps = deps ?? defaultDeps(plan)
  const resolveReuse = builtDeps.resolveReuse ?? defaultDeps(plan).resolveReuse!
  const scanRisk = builtDeps.scanRisk ?? scanRiskDefault

  const now = new Date().toISOString()
  const nodes: CwcNode[] = []
  const edges: CwcEdge[] = []
  const usedNames = new Set<string>()
  let x = 0
  let previousId: string | null = null
  let edgeSeq = 1

  const addEdge = (from: string, to: string | null, trigger: string, terminalType?: CwcEdge['terminalType']): void => {
    const edge: CwcEdge = { id: `edge-${edgeSeq++}`, from, to, trigger }
    if (terminalType) edge.terminalType = terminalType
    edges.push(edge)
  }

  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex++) {
    const phase = plan.phases[phaseIndex]
    const steps = phaseSteps(phase, automation)
    const stepText = steps.join('\n')
    const decision = resolveReuse(phase, automation, catalog)
    if (phase.reuse && !decision.attach) {
      input.onLog?.(`Reuse ${phase.reuse.slug} demoted to bespoke: ${decision.reason ?? 'failed shapeCheck or capability threshold'}`)
    }

    const archetype = decision.attach ? GENERIC : matchArchetype(phase.archetypeHint, stepText)
    const useArchetypeRisk = deps?.scanRisk === undefined
    const risky = scanRisk(phase, automation) || (useArchetypeRisk && !decision.attach && archetype.risky)
    // A gate needs a preceding agent to approve — it can never be the workflow's entry node.
    // If the first phase is risky there is nothing before it to gate; the phase's own systemPrompt
    // still carries the risk policy.
    if (risky && previousId) {
      const gateId = `node-gate-${phase.id}`
      const gateName = uniqueName('Approval Gate', usedNames)
      nodes.push({
        id: gateId,
        position: { x, y: Y_BASE },
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
      if (previousId) addEdge(previousId, gateId, makeHandoffTrigger(nodes, previousId))
      previousId = gateId
      x += X_STEP
    }

    const phaseName = uniqueName(titleCase(phase.intent), usedNames)
    const nodeId = `node-${phase.id}`
    let node: CwcNode

    if (decision.attach && decision.kind === 'agent') {
      node = {
        id: nodeId,
        position: { x, y: Y_BASE },
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
        position: { x, y: Y_BASE },
        exportedSlug: null,
        agent: {
          name: phaseName,
          description: phase.intent,
          completionCriteria: buildCompletionCriteria(phaseName),
          color: 'blue',
          tools: ['Bash', 'Read'],
          skills: [decision.slug],
          systemPrompt: `Run the /${decision.slug} skill to ${phase.intent}.`,
        },
      }
    } else {
      node = {
        id: nodeId,
        position: { x, y: Y_BASE },
        exportedSlug: null,
        agent: {
          name: phaseName,
          description: phase.intent,
          completionCriteria: buildCompletionCriteria(phaseName),
          color: 'blue',
          tools: [...archetype.tools],
          skills: [],
          systemPrompt: buildSystemPrompt({
            automationName: automation.title,
            phaseName,
            goal: phase.intent,
            steps,
            risky,
          }),
        },
      }
    }

    // No gate ever precedes the first phase, so the first phase node is always the entry node.
    if (phaseIndex === 0) {
      node.startTrigger = `Start when this repeated work is needed: ${automation.suggestedTrigger.label}`
    }

    nodes.push(node)
    if (previousId) addEdge(previousId, nodeId, makeHandoffTrigger(nodes, previousId))
    previousId = nodeId
    x += X_STEP
  }

  if (previousId) addEdge(previousId, null, `${previousNodeName(nodes, previousId)} completes the workflow.`, 'complete')

  return selfHeal({
    meta: {
      id: randomUUID(),
      name: plan.name || automation.title,
      description: plan.description || automation.description,
      version: 1,
      created: now,
      updated: now,
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
