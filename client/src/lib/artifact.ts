import type { CwcFile, CwcNode, CwcTrigger } from '../types.ts'
import {
  artifactKindOf as resolveArtifactKind,
  artifactTierOf as resolveArtifactTier,
} from '../../../src/schema.ts'
import {
  currentArtifactSkillSlug,
  deployedArtifactSkillSlug,
} from '../../../src/slugify.ts'

export type ArtifactKind = 'workflow' | 'skill'
export type ArtifactTier = 'rule' | 'skill' | 'loop' | 'workflow'
export type RunnableArtifactTier = Exclude<ArtifactTier, 'rule'>

export function artifactKindOf(cwc: CwcFile): ArtifactKind {
  return resolveArtifactKind(cwc)
}

export function artifactTierOf(cwc: CwcFile): RunnableArtifactTier {
  return resolveArtifactTier(cwc)
}

export function artifactTierLabel(tier: ArtifactTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

export function artifactNoun(cwc: CwcFile): string {
  return artifactTierLabel(artifactTierOf(cwc))
}

/** Skill artifacts become loops when they have recurrence or a retained verification
 * condition, and return to plain skills when the last such condition is removed. */
export function artifactTierAfterTriggerChange(
  cwc: CwcFile,
  triggers: CwcTrigger[],
): RunnableArtifactTier {
  if (artifactKindOf(cwc) === 'workflow') return 'workflow'
  return triggers.length > 0 || hasExplicitLoopStop(cwc) ? 'loop' : 'skill'
}

/** Verification metadata is useful provenance for an ordinary skill too. It is
 * loop semantics only when the editable skill body actually contains the
 * generated verify/no-progress stopping contract. */
export function hasExplicitLoopStop(cwc: CwcFile): boolean {
  const hasVerification = Boolean(
    cwc.meta.sourceAutomation?.verificationCommand
    || cwc.meta.sourceAutomation?.verificationStep,
  )
  const body = cwc.nodes.length === 1 && isBespokeNode(cwc.nodes[0])
    ? cwc.nodes[0].agent.systemPrompt ?? ''
    : ''
  return hasVerification && /^## Verification stop condition\s*$/im.test(body)
}

/** Slug produced by the artifact's current name/kind. Use for export previews and writes. */
export function currentArtifactSlug(cwc: CwcFile): string {
  return currentArtifactSkillSlug(cwc)
}

/** Slug that is runnable now. A rename does not take effect until the next export. */
export function deployedArtifactSlug(cwc: CwcFile): string {
  return deployedArtifactSkillSlug(cwc)
}

export function isBespokeNode(node: CwcNode | undefined): node is CwcNode {
  return Boolean(node && node.nodeType !== 'gate' && !node.agentRef)
}

/** A terminal edge carries no second role, so it is safe to discard during demotion. */
export function canDemoteArtifact(cwc: CwcFile): boolean {
  if (artifactKindOf(cwc) !== 'workflow' || cwc.nodes.length !== 1 || !isBespokeNode(cwc.nodes[0])) return false
  if (cwc.edges.length === 0) return true
  const terminal = cwc.edges[0]
  return cwc.edges.length === 1
    && terminal.from === cwc.nodes[0].id
    && terminal.to === null
    && terminal.terminalType === 'complete'
    && (!terminal.context || terminal.context.length === 0)
}

/**
 * Extract only the FIRST top-level ordered list. Nested lists and prose are intentionally
 * ignored, and a heading after the list ends it, so a later section (e.g. Troubleshooting)
 * with its own numbered list is never merged into the primary procedure: over-splitting a
 * skill is worse than graduating it as one faithful workflow node.
 */
export function extractNumberedChecklist(markdown: string): string[] {
  const steps: string[] = []
  let inFence = false
  let listStarted = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = line.match(/^ {0,3}\d+[.)]\s+(.+\S|\S)\s*$/)
    if (!match) {
      // A heading after the list has started closes the primary procedure.
      if (listStarted && /^ {0,3}#{1,6}\s/.test(line)) break
      continue
    }
    listStarted = true
    const step = match[1].trim()
    if (step && !steps.includes(step)) steps.push(step)
  }
  return steps.length >= 2 ? steps : []
}
