import { useReducer } from 'react'
import type { CwcFile, CwcNode, CwcEdge, CwcAgent } from '../types.ts'
import { v4 as uuidv4 } from 'uuid'
import { CWC_FILE_VERSION } from '../../../src/schema.ts'
import {
  artifactKindOf,
  artifactTierAfterTriggerChange,
  canDemoteArtifact,
  extractNumberedChecklist,
  isBespokeNode,
} from '../lib/artifact.ts'
import type { DetectedAutomation } from '../../../src/detection/types.ts'
import { fallbackPlan } from '../../../src/generation/fallback-plan.ts'
import { buildCompletionCriteria, buildSystemPrompt, matchArchetype } from '../../../src/generation/archetypes.ts'
import { scanRisk } from '../../../src/generation/risk-scanner.ts'
import {
  externalActionBearingLines,
  externalActionSignals,
  externalMutationToolNames,
} from '../../../src/generation/external-action-risk.ts'
import { agentSlug } from '../../../src/slugify.ts'

export type WorkflowAction =
  | { type: 'LOAD'; payload: CwcFile }
  | { type: 'SET_META'; payload: Partial<CwcFile['meta']> }
  | { type: 'UPDATE_SKILL'; payload: { name?: string; description?: string; body?: string } }
  | { type: 'CONVERT_ARTIFACT'; payload: { to: 'workflow' | 'skill' } }
  | { type: 'ADD_NODE'; payload: { agent: CwcAgent; position: { x: number; y: number }; agentRef?: string; nodeType?: 'agent' | 'gate' } }
  | { type: 'UPDATE_NODE'; payload: { nodeId: string; agent: Partial<CwcAgent>; startTrigger?: string; dispatchMode?: 'parallel' | 'conditional' } }
  | { type: 'MOVE_NODE'; payload: { nodeId: string; position: { x: number; y: number } } }
  | { type: 'REMOVE_NODE'; payload: { nodeId: string } }
  | { type: 'ADD_EDGE'; payload: Omit<CwcEdge, 'id'> }
  | { type: 'UPDATE_EDGE'; payload: { edgeId: string } & Partial<Omit<CwcEdge, 'id'>> }
  | { type: 'REMOVE_EDGE'; payload: { edgeId: string } }
  | { type: 'UPDATE_EXPORTED_SLUG'; payload: { nodeId: string; slug: string | null } }
  | { type: 'SET_EXPORTED_WORKFLOW_SLUG'; payload: { slug: string } }
  | { type: 'COMMIT_EXPORT'; payload: { source: CwcFile; deployed: CwcFile } }
  | { type: 'CLEAR_EXPORT_STATE' }
  | { type: 'UNDO' }
  | { type: 'REDO' }

function reducer(state: CwcFile, action: WorkflowAction): CwcFile {
  const now = new Date().toISOString()
  switch (action.type) {
    case 'LOAD': return action.payload
    case 'UNDO':
    case 'REDO': return state
    case 'SET_META': return { ...state, meta: { ...state.meta, ...action.payload, updated: now } }
    case 'UPDATE_SKILL': {
      if (artifactKindOf(state) !== 'skill' || state.nodes.length !== 1 || !isBespokeNode(state.nodes[0])) return state
      const node = state.nodes[0]
      const name = action.payload.name ?? node.agent.name
      const description = action.payload.description ?? node.agent.description
      const next: CwcFile = {
        ...state,
        meta: {
          ...state.meta,
          name: action.payload.name === undefined ? state.meta.name : name,
          description: action.payload.description === undefined ? state.meta.description : description,
          updated: now,
        },
        nodes: [{
          ...node,
          agent: {
            ...node.agent,
            name,
            description,
            systemPrompt: action.payload.body ?? node.agent.systemPrompt,
          },
        }],
      }
      // The editable stop-condition heading is part of loop semantics, not mere
      // provenance. Keep the badge/runtime tier synchronized when a verify-only
      // loop's body removes or restores that contract; recurrence still wins.
      return {
        ...next,
        meta: {
          ...next.meta,
          artifactTier: artifactTierAfterTriggerChange(next, next.meta.triggers ?? []),
        },
      }
    }
    case 'CONVERT_ARTIFACT':
      return action.payload.to === 'workflow'
        ? graduateSkill(state, now)
        : demoteWorkflow(state, now)
    case 'ADD_NODE': {
      const node: CwcNode = {
        id: `node-${uuidv4().slice(0, 8)}`,
        position: action.payload.position,
        exportedSlug: null,
        agent: action.payload.agent,
        agentRef: action.payload.agentRef,
        nodeType: action.payload.nodeType,
      }
      return { ...state, nodes: [...state.nodes, node], meta: { ...state.meta, updated: now } }
    }
    case 'UPDATE_NODE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      nodes: state.nodes.map((n) =>
        n.id === action.payload.nodeId
          ? { ...n, agent: { ...n.agent, ...action.payload.agent }, startTrigger: action.payload.startTrigger ?? n.startTrigger, dispatchMode: action.payload.dispatchMode ?? n.dispatchMode }
          : n
      ),
    }
    case 'MOVE_NODE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      nodes: state.nodes.map((n) => n.id === action.payload.nodeId ? { ...n, position: action.payload.position } : n),
    }
    case 'REMOVE_NODE': {
      const removed = state.nodes.find(node => node.id === action.payload.nodeId)
      // A failed rename cleanup deliberately retains the old exportedSlug as retry
      // authority even though the newly rendered agent already exists under the
      // current name-derived slug. Queue both identities so removing the node cannot
      // orphan either owned file on the next export/delete.
      const cleanupSlugs = removed && isBespokeNode(removed) && removed.exportedSlug
        ? [removed.exportedSlug, agentSlug(removed.agent.name)]
        : []
      const pendingAgentSlugs = cleanupSlugs.length > 0
        ? [...new Set([...(state.meta.pendingExportCleanup?.agentSlugs ?? []), ...cleanupSlugs])].sort()
        : state.meta.pendingExportCleanup?.agentSlugs
      const pendingExportCleanup = cleanupSlugs.length > 0
        ? {
            ...state.meta.pendingExportCleanup,
            agentSlugs: pendingAgentSlugs,
          }
        : state.meta.pendingExportCleanup
      return {
        ...state,
        meta: { ...state.meta, updated: now, pendingExportCleanup },
        nodes: state.nodes.filter((n) => n.id !== action.payload.nodeId),
        edges: state.edges.filter((e) => e.from !== action.payload.nodeId && e.to !== action.payload.nodeId),
      }
    }
    case 'ADD_EDGE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      edges: [...state.edges, { id: `edge-${uuidv4().slice(0, 8)}`, ...action.payload }],
    }
    case 'UPDATE_EDGE': {
      const { edgeId, ...rest } = action.payload
      return {
        ...state,
        meta: { ...state.meta, updated: now },
        edges: state.edges.map((e) => e.id === edgeId ? { ...e, ...rest } : e),
      }
    }
    case 'REMOVE_EDGE': return {
      ...state,
      meta: { ...state.meta, updated: now },
      edges: state.edges.filter((e) => e.id !== action.payload.edgeId),
    }
    case 'UPDATE_EXPORTED_SLUG': return {
      ...state,
      nodes: state.nodes.map((n) => n.id === action.payload.nodeId ? { ...n, exportedSlug: action.payload.slug } : n),
    }
    case 'SET_EXPORTED_WORKFLOW_SLUG': return {
      ...state,
      meta: { ...state.meta, exportedWorkflowSlug: action.payload.slug },
    }
    case 'COMMIT_EXPORT': return action.payload.deployed
    case 'CLEAR_EXPORT_STATE': return {
      ...state,
      meta: { ...state.meta, exportedWorkflowSlug: undefined, pendingExportCleanup: undefined },
      nodes: state.nodes.map((node) => ({ ...node, exportedSlug: null })),
    }
    default: return state
  }
}

function stepName(step: string, index: number): string {
  const plain = step
    .replace(/[`*_#>\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const clipped = plain.split(' ').slice(0, 7).join(' ')
  return clipped ? `Step ${index + 1}: ${clipped}`.slice(0, 60) : `Step ${index + 1}`
}

function normalizedRiskInstruction(value: string): string {
  return value.trim()
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .toLowerCase()
}

/** Preserve user-authored context around a risky checklist without copying an
 * external action across an earlier approval boundary. Backslash continuations
 * are collapsed first so a multi-line shell mutation is removed as one logical
 * instruction instead of being reconstructed from individually harmless lines. */
function nonExternalSourceContext(value: string): string {
  return value
    .replace(/\\\r?\n[\t ]*/g, '')
    .split(/\r?\n/)
    .filter(line => externalActionSignals(line).size === 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function graduatedConnectorToolPolicy(tools: readonly string[]): string {
  if (tools.length === 0) return ''
  const names = tools.map(tool => `\`${tool}\``).join(', ')
  return `\n\n## Approved connector tool policy\n\nUse ${names} only after the immediately preceding approval gate has been approved, and only for external actions explicitly assigned to this focused phase. Do not use ${tools.length === 1 ? 'this tool' : 'these tools'} for another phase or for an inferred action.`
}

function graduateSkill(state: CwcFile, now: string): CwcFile {
  if (artifactKindOf(state) !== 'skill' || state.nodes.length !== 1 || !isBespokeNode(state.nodes[0])) return state
  const source = state.nodes[0]
  const originalBody = source.agent.systemPrompt?.trim() ?? ''
  const extractedSteps = extractNumberedChecklist(originalBody)
  const hasCurrentChecklist = extractedSteps.length > 0
  // Retained detection steps are provenance, not executable authority after the
  // user edits the skill. Without a current checklist, keep one phase and carry
  // the current body into it instead of resurrecting removed source actions.
  const steps = hasCurrentChecklist
    ? extractedSteps
    : [state.meta.description.trim() || state.meta.name || 'Run the current skill instructions']
  const automation: DetectedAutomation = {
    id: state.meta.sourceAutomation?.id ?? state.meta.id,
    title: state.meta.name,
    description: state.meta.description,
    steps,
    stepTokens: [],
    evidence: { count: 1, repos: [], sessionIds: [], firstSeen: state.meta.created, lastSeen: state.meta.updated },
    suggestedTrigger: { kind: 'manual', label: source.startTrigger || 'on demand' },
    confidence: 1,
    status: 'promoted',
  }
  const plan = fallbackPlan(automation)
  const groundedRiskInstructions = new Set(
    steps
      .filter(step => externalActionSignals(step).size > 0)
      .map(normalizedRiskInstruction),
  )
  // The editable body is authoritative after graduation. If it now contains an
  // external action that the extracted/retained phases do not represent, gate the
  // whole workflow before any agent receives that body as authoritative context.
  const ungroundedBodyRiskInstructions = externalActionBearingLines(originalBody)
    .map(line => line.trim())
    .filter(line => !groundedRiskInstructions.has(normalizedRiskInstruction(line)))
  const needsEntryBodyRiskGate = ungroundedBodyRiskInstructions.length > 0
  const sourceMutatingTools = externalMutationToolNames(source.agent.tools ?? [])
  const basePhaseContexts = plan.phases.map(phase => {
    const phaseSteps = phase.stepIndexes.map((index) => steps[index]).filter(Boolean)
    const phaseGrounding = hasCurrentChecklist ? phaseSteps.join('\n') : originalBody
    const archetype = matchArchetype(phase.archetypeHint, phaseGrounding)
    return {
      phaseSteps,
      archetype,
      risky: scanRisk(phase, automation) || archetype.risky,
    }
  })
  const lastPlannedRiskIndex = basePhaseContexts.reduce((last, context, index) => context.risky ? index : last, -1)
  const inheritedToolPhaseIndex = lastPlannedRiskIndex >= 0 ? lastPlannedRiskIndex : 0
  // A connector method name is stronger evidence than editable prose. Even when
  // the body says only "update the page", retain that exact capability on one
  // runnable phase and force an approval boundary immediately before it.
  const phaseContexts = basePhaseContexts.map((context, index) => ({
    ...context,
    risky: context.risky || (sourceMutatingTools.length > 0 && index === inheritedToolPhaseIndex),
  }))
  const firstPlannedRiskIndex = phaseContexts.findIndex(context => context.risky)
  const hasAnyApprovalBoundary = needsEntryBodyRiskGate || firstPlannedRiskIndex >= 0
  const safeSourceContext = nonExternalSourceContext(originalBody)
  const nodes: CwcNode[] = []
  const edges: CwcEdge[] = []
  let previousId: string | null = null
  let edgeIndex = 1
  let x = 0
  let carriedExportSlug = false

  const oldExportSlug = source.exportedSlug
  const exportedSlugForBespokeNode = (): string | null => {
    if (carriedExportSlug || !oldExportSlug) return null
    carriedExportSlug = true
    return oldExportSlug
  }
  const addEdge = (from: string, to: string | null, terminalType?: CwcEdge['terminalType']) => {
    const fromName = nodes.find((node) => node.id === from)?.agent.name ?? 'Previous phase'
    edges.push({
      id: `edge-graduate-${edgeIndex++}`,
      from,
      to,
      trigger: to === null
        ? `${fromName} completes the workflow.`
        : `${fromName} is complete and has handed off the required context.`,
      ...(terminalType ? { terminalType } : {}),
    })
  }

  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex++) {
    const phase = plan.phases[phaseIndex]
    const { phaseSteps, archetype } = phaseContexts[phaseIndex]
    const phaseMutatingTools = phaseIndex === inheritedToolPhaseIndex ? sourceMutatingTools : []
    const ungroundedEntryRisk = phaseIndex === 0 && needsEntryBodyRiskGate
    const risky = phaseContexts[phaseIndex].risky || ungroundedEntryRisk

    // Mirror compiler safety semantics: a risky entry phase needs a read-only
    // preflight because approval gates cannot be entry nodes.
    if (risky && previousId === null) {
      const preflightId = `node-graduate-preflight-${phase.id}`
      nodes.push({
        id: preflightId,
        position: { x, y: 300 },
        exportedSlug: exportedSlugForBespokeNode(),
        startTrigger: source.startTrigger || `Start when ${state.meta.name} is needed.`,
        agent: {
          name: 'Preflight Review',
          description: `Prepare approval context before ${phase.intent}.`,
          completionCriteria: 'The reviewer has the target, prerequisites, current state, requested external action, and material risks needed for approval.',
          color: source.agent.color ?? 'blue',
          model: source.agent.model,
          tools: ['Read'],
          skills: [],
          systemPrompt: `Perform a read-only preflight for the upcoming phase: ${phase.intent}.\n\nInspect relevant repository files and the workflow input. Summarize the target, prerequisites, current state, exact irreversible external action requested, and material risks for the reviewer.${ungroundedEntryRisk ? `\n\nThe current source skill contains external-action instructions that were not represented by its retained phases. Review them explicitly:\n\n${originalBody}` : ''}\n\nDo not publish, deploy, push, send, or mutate files or external systems. Do not run shell commands. Stop after preparing approval context.`,
        },
      })
      previousId = preflightId
      x += 350
    }

    if (risky && previousId !== null) {
      const gateId = `node-graduate-gate-${phase.id}`
      nodes.push({
        id: gateId,
        position: { x, y: 300 },
        exportedSlug: null,
        nodeType: 'gate',
        agent: {
          name: 'Approval Gate',
          description: 'Pause for human approval before high-risk external or production-impacting actions.',
          completionCriteria: '',
          tools: [],
          skills: [],
          systemPrompt: '',
        },
      })
      addEdge(previousId, gateId)
      previousId = gateId
      x += 350
    }

    const nodeId = `node-graduate-${phase.id}`
    const phaseName = stepName(phase.intent, phaseIndex)
    const focusedPrompt = buildSystemPrompt({
      automationName: state.meta.name,
      phaseName,
      goal: phase.intent,
      steps: phaseSteps,
      risky,
    })
    // The whole source body can contain actions belonging to several independently
    // gated phases. Keep non-action operational constraints available to every
    // phase, but copy each external action only through its focused checklist step
    // or, for source-only actions, into the first phase after the entry gate.
    const boundedSourceContext = safeSourceContext
      ? `\n\n## Non-action source context\n\n${safeSourceContext}\n\nUse this context only where it applies to the focused phase.`
      : ''
    const entryGatedContext = ungroundedEntryRisk
      ? `\n\n## Entry-gated source instructions\n\n${ungroundedBodyRiskInstructions.join('\n')}\n\nThese exact source-only actions were reviewed by the preceding gate. Complete them only as part of this focused phase, then hand off.`
      : ''
    const originalContext = !hasAnyApprovalBoundary
      ? `\n\n## Original skill instructions\n\n${originalBody}\n\nUse the original instructions as authoritative context, but complete only this phase before handing off.`
      : `${boundedSourceContext}${entryGatedContext}\n\nExternal actions belonging to other approval phases are intentionally withheld. Complete only the focused phase above and hand off its result.`
    const node: CwcNode = {
      id: nodeId,
      position: { x, y: 300 },
      exportedSlug: exportedSlugForBespokeNode(),
      agent: {
        ...source.agent,
        name: phaseName,
        description: phaseSteps.join(' → ') || phase.intent,
        completionCriteria: buildCompletionCriteria(phaseName),
        // A single skill has one tool policy, while a workflow has one per phase.
        // Preserve its exact capabilities on one phase only; the last risky phase
        // is safest because every earlier approval boundary has already passed.
        tools: [...new Set([
          ...archetype.tools,
          ...(phaseIndex === inheritedToolPhaseIndex ? (source.agent.tools ?? []) : []),
        ])],
        skills: [],
        systemPrompt: `${focusedPrompt}${originalContext}${graduatedConnectorToolPolicy(phaseMutatingTools)}`,
      },
    }
    if (previousId === null) node.startTrigger = source.startTrigger || `Start when ${state.meta.name} is needed.`
    nodes.push(node)
    if (previousId !== null) addEdge(previousId, nodeId)
    previousId = nodeId
    x += 350
  }

  if (previousId !== null) addEdge(previousId, null, 'complete')

  return {
    ...state,
    meta: {
      ...state.meta,
      version: CWC_FILE_VERSION,
      artifactKind: 'workflow',
      artifactTier: 'workflow',
      updated: now,
    },
    nodes,
    edges,
  }
}

function demoteWorkflow(state: CwcFile, now: string): CwcFile {
  if (!canDemoteArtifact(state)) return state
  const original = state.nodes[0]
  const name = state.meta.name.trim() || original.agent.name
  const description = state.meta.description.trim() || original.agent.description
  const isLoop = Boolean(
    state.meta.sourceAutomation?.verificationCommand
    || state.meta.sourceAutomation?.verificationStep
    || (state.meta.triggers?.length ?? 0) > 0
  )
  const bodySections = [original.agent.systemPrompt?.trim() ?? ''].filter(Boolean)
  if (original.startTrigger?.trim()) {
    bodySections.push(`## When to use\n\n${original.startTrigger.trim()}`)
  }
  if ((original.agent.skills?.length ?? 0) > 0) {
    bodySections.push(`## Required skills\n\n${original.agent.skills!.map(slug => `- Use the \`/${slug}\` skill.`).join('\n')}`)
  }
  const executionPolicy: string[] = []
  if ((original.agent.tools?.length ?? 0) > 0) {
    executionPolicy.push(`- Keep tool use within: ${original.agent.tools!.map(tool => `\`${tool}\``).join(', ')}.`)
  }
  if (original.agent.model?.trim()) {
    executionPolicy.push(`- Preserve the previous model preference when available: \`${original.agent.model.trim()}\`.`)
  }
  if (executionPolicy.length > 0) bodySections.push(`## Execution policy\n\n${executionPolicy.join('\n')}`)
  if (original.agent.completionCriteria?.trim()) {
    bodySections.push(`## Completion criteria\n\nBefore returning, verify: ${original.agent.completionCriteria.trim()}`)
  }
  const terminalTrigger = state.edges[0]?.trigger?.trim()
  if (terminalTrigger) bodySections.push(`Finish this skill when: ${terminalTrigger}`)
  const verificationCommand = state.meta.sourceAutomation?.verificationCommand?.trim()
  const verificationStep = state.meta.sourceAutomation?.verificationStep?.replace(/\s+/g, ' ').trim()
  const alreadyHasStopCondition = bodySections.some(section => /^## Verification stop condition\b/m.test(section))
  if (!alreadyHasStopCondition && (verificationCommand || verificationStep)) {
    const instruction = verificationCommand
      ? `After each fix round, run this observed verification command:\n\n    ${verificationCommand}`
      : `After each fix round, repeat this observed verification step: ${verificationStep}`
    bodySections.push(`## Verification stop condition\n\n${instruction}\n\nStop when verification passes. Also stop and report the blocker when two rounds make no progress.`)
  }
  return {
    ...state,
    meta: {
      ...state.meta,
      name,
      description,
      version: CWC_FILE_VERSION,
      artifactKind: 'skill',
      artifactTier: isLoop ? 'loop' : 'skill',
      updated: now,
    },
    nodes: [{
      ...original,
      position: { x: 0, y: 0 },
      startTrigger: undefined,
      dispatchMode: undefined,
      agent: { ...original.agent, name, description, systemPrompt: bodySections.join('\n\n') },
    }],
    edges: [],
  }
}

function makeEmptyWorkflow(): CwcFile {
  const now = new Date().toISOString()
  return {
    meta: {
      id: '',
      name: 'Untitled Workflow',
      description: '',
      version: CWC_FILE_VERSION,
      artifactKind: 'workflow',
      artifactTier: 'workflow',
      created: now,
      updated: now,
    },
    nodes: [],
    edges: [],
  }
}

const MAX_HISTORY = 100

export interface HistoryState {
  past: CwcFile[]
  present: CwcFile
  future: CwcFile[]
  lastKey: string | null
}

/** Files written by an export are keyed by artifact kind plus bespoke workflow node IDs.
 * Undo may safely retain content edits while this shape stays stable, but crossing a kind or
 * agent-topology boundary would restore a recipe that cannot name every deployed agent file. */
function deploymentShapeKey(cwc: CwcFile): string {
  const kind = artifactKindOf(cwc)
  const bespokeNodeIds = kind === 'workflow'
    ? cwc.nodes.filter(isBespokeNode).map(node => node.id).sort()
    : []
  return `${kind}:${bespokeNodeIds.join(',')}`
}

function withDeploymentIdentity(snapshot: CwcFile, deployed: CwcFile, preserveLiveCleanup = false): CwcFile {
  const exportedSlugByNode = new Map(deployed.nodes.map(node => [node.id, node.exportedSlug]))
  const representedNodeIds = new Set(snapshot.nodes.map(node => node.id))
  const orphanedAgentSlugs = preserveLiveCleanup
    ? deployed.nodes
        .filter(node => !representedNodeIds.has(node.id) && isBespokeNode(node) && node.exportedSlug)
        .map(node => node.exportedSlug as string)
    : []
  const skillSlugs = preserveLiveCleanup
    ? [...new Set([
        ...(snapshot.meta.pendingExportCleanup?.skillSlugs ?? []),
        ...(deployed.meta.pendingExportCleanup?.skillSlugs ?? []),
      ])].sort()
    : deployed.meta.pendingExportCleanup?.skillSlugs
  const agentSlugs = preserveLiveCleanup
    ? [...new Set([
        ...(snapshot.meta.pendingExportCleanup?.agentSlugs ?? []),
        ...(deployed.meta.pendingExportCleanup?.agentSlugs ?? []),
        ...orphanedAgentSlugs,
      ])].sort()
    : deployed.meta.pendingExportCleanup?.agentSlugs
  const pendingExportCleanup = skillSlugs?.length || agentSlugs?.length
    ? {
        ...(skillSlugs?.length ? { skillSlugs } : {}),
        ...(agentSlugs?.length ? { agentSlugs } : {}),
      }
    : undefined
  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      exportedWorkflowSlug: deployed.meta.exportedWorkflowSlug,
      pendingExportCleanup,
    },
    nodes: snapshot.nodes.map(node => exportedSlugByNode.has(node.id)
      ? { ...node, exportedSlug: exportedSlugByNode.get(node.id) ?? null }
      : node),
  }
}

// Rapid edits that share a coalesce key (typing in a text field, retitling) collapse
// into a single undo step instead of one step per keystroke.
function coalesceKey(action: WorkflowAction): string | null {
  switch (action.type) {
    case 'SET_META': return 'meta'
    case 'UPDATE_NODE': return `update:${action.payload.nodeId}`
    case 'UPDATE_SKILL': return 'update:skill'
    case 'MOVE_NODE': return `move:${action.payload.nodeId}`
    default: return null
  }
}

export function historyReducer(state: HistoryState, action: WorkflowAction): HistoryState {
  switch (action.type) {
    case 'LOAD':
      return { past: [], present: reducer(state.present, action), future: [], lastKey: null }
    case 'UNDO': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], lastKey: null }
    }
    case 'REDO': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1), lastKey: null }
    }
    case 'COMMIT_EXPORT': {
      const { source, deployed } = action.payload
      const shape = deploymentShapeKey(deployed)
      const liveShape = deploymentShapeKey(state.present)
      const sourceStillLive = JSON.stringify(state.present) === JSON.stringify(source)

      // Export runs asynchronously. A user can legitimately change artifact kind or
      // bespoke-agent topology while the request is in flight (for example by closing
      // the modal after confirmation and graduating a skill). The completed deployment
      // still supplies useful cleanup identity, but it must never replace that newer
      // editor state or discard its undo history.
      if (!sourceStillLive && liveShape !== shape) {
        return {
          past: state.past.map(snapshot => withDeploymentIdentity(snapshot, deployed, true)),
          present: withDeploymentIdentity(state.present, deployed, true),
          future: state.future.map(snapshot => withDeploymentIdentity(snapshot, deployed, true)),
          lastKey: null,
        }
      }

      let pastStart = state.past.length
      while (pastStart > 0 && deploymentShapeKey(state.past[pastStart - 1]) === shape) pastStart--
      let futureEnd = 0
      while (futureEnd < state.future.length && deploymentShapeKey(state.future[futureEnd]) === shape) futureEnd++
      return {
        past: state.past.slice(pastStart).map(snapshot => withDeploymentIdentity(snapshot, deployed)),
        // Export is asynchronous. Preserve an edit made while the request was in flight when
        // it has the same deployment shape; the server result still supplies authoritative slugs.
        present: sourceStillLive ? deployed : withDeploymentIdentity(state.present, deployed, true),
        future: state.future.slice(0, futureEnd).map(snapshot => withDeploymentIdentity(snapshot, deployed)),
        lastKey: null,
      }
    }
    // Post-export bookkeeping — should never land on the undo stack.
    case 'UPDATE_EXPORTED_SLUG':
    case 'SET_EXPORTED_WORKFLOW_SLUG':
    case 'CLEAR_EXPORT_STATE':
      return {
        ...state,
        past: state.past.map((snapshot) => reducer(snapshot, action)),
        present: reducer(state.present, action),
        future: state.future.map((snapshot) => reducer(snapshot, action)),
      }
    default: {
      const present = reducer(state.present, action)
      if (present === state.present) return state
      const key = coalesceKey(action)
      const coalesce = key !== null && key === state.lastKey
      const past = coalesce ? state.past : [...state.past, state.present].slice(-MAX_HISTORY)
      return { past, present, future: [], lastKey: key }
    }
  }
}

export function useWorkflow(initial?: CwcFile) {
  const [state, dispatch] = useReducer(
    historyReducer,
    undefined,
    (): HistoryState => ({ past: [], present: initial ?? makeEmptyWorkflow(), future: [], lastKey: null })
  )
  return { workflow: state.present, dispatch, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
