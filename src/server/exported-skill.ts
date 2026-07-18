import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import matter from 'gray-matter'
import {
  parseBespokeAgentDeclaration,
  unsupportedAgentDispatchTypes,
  unqualifiedAgentDispatchSlugs,
} from '../export/deployment-metadata.js'
import { CANONICAL_SLUG_RE as SKILL_SLUG_RE } from '../slugify.js'

const MAX_MANAGED_SKILL_BYTES = 2 * 1024 * 1024
const OWNERSHIP_RE = /^<!-- cwc:workflow:([^:\s>]+) -->$/
const AGENT_OWNERSHIP_RE = /^<!-- cwc:node:([^:\s>]+):workflow:([^:\s>]+) -->$/

/** Return the artifact id only when the ownership marker is the final non-blank
 * line. A marker embedded in user-authored prose is not CWC authority. */
export function ownedExportedSkillId(raw: string): string | null {
  const line = raw.split('\n').map(value => value.trim()).filter(Boolean).at(-1)
  return line?.match(OWNERSHIP_RE)?.[1] ?? null
}

type SkillInspection =
  | { status: 'absent' | 'foreign' }
  | { status: 'owned'; contentHash: string; content: string }

export interface OwnedExportedSkill {
  scope: 'project' | 'user'
  contentHash: string
  content: string
}

export interface ExportedAgentBinding {
  slug: string
  scope: 'project' | 'user'
  kind: 'bespoke' | 'reference'
  contentHash: string
  content: string
}

export class OwnedExportedAgentDeploymentError extends Error {}
export class OwnedExportedAgentCollisionError extends OwnedExportedAgentDeploymentError {}
export class OwnedExportedAgentDeclarationError extends OwnedExportedAgentDeploymentError {}
export class OwnedExportedAgentMissingError extends OwnedExportedAgentDeploymentError {}
export class OwnedExportedAgentReferenceError extends OwnedExportedAgentDeploymentError {}

export function ownedExportedAgentId(raw: string): string | null {
  const line = raw.split('\n').map(value => value.trim()).filter(Boolean).at(-1)
  return line?.match(AGENT_OWNERSHIP_RE)?.[2] ?? null
}

async function inspectOwnership(filePath: string, artifactId: string): Promise<SkillInspection> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.size > MAX_MANAGED_SKILL_BYTES) return { status: 'foreign' }
    const content = await fs.readFile(filePath, 'utf-8')
    if (ownedExportedSkillId(content) !== artifactId) return { status: 'foreign' }
    return { status: 'owned', contentHash: createHash('sha256').update(content).digest('hex'), content }
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err
      && (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'foreign' }
  }
}

/** Resolve user- and project-scoped exports, accepting only an exact CWC owner.
 * This prevents a same-slug hand-authored skill from being run with managed-run
 * permissions when an export failed, was removed, or changed scope. */
export async function resolveOwnedExportedSkill(options: {
  artifactId: string
  skillSlug: string
  userSkillsDir: string
  projectDir: string
}): Promise<OwnedExportedSkill | null> {
  if (!SKILL_SLUG_RE.test(options.skillSlug)) return null
  const projectSkill = path.join(options.projectDir, '.claude', 'skills', options.skillSlug, 'SKILL.md')
  const projectOwnership = await inspectOwnership(projectSkill, options.artifactId)
  // Claude resolves project-local skills before user skills. If that path exists,
  // its identity is authoritative; an owned user export must not bless a foreign
  // project collision that is the file Claude will actually invoke.
  if (projectOwnership.status !== 'absent') {
    return projectOwnership.status === 'owned'
      ? { scope: 'project', contentHash: projectOwnership.contentHash, content: projectOwnership.content }
      : null
  }

  const userSkill = path.join(options.userSkillsDir, options.skillSlug, 'SKILL.md')
  const userOwnership = await inspectOwnership(userSkill, options.artifactId)
  return userOwnership.status === 'owned'
    ? { scope: 'user', contentHash: userOwnership.contentHash, content: userOwnership.content }
    : null
}

export async function hasOwnedExportedSkill(options: {
  artifactId: string
  skillSlug: string
  userSkillsDir: string
  projectDir: string
}): Promise<boolean> {
  return await resolveOwnedExportedSkill(options) !== null
}

type AgentInspection =
  | { status: 'absent' | 'invalid' }
  | { status: 'owned' | 'reference'; contentHash: string; content: string }

/** Resolve exact filesystem-backed Agent-tool dependencies. Declared bespoke
 * agents must remain workflow-owned; plain reference agents retain their
 * semantic kind but are also snapshotted so worktree isolation cannot silently
 * switch an untracked/dirty project reference to different bytes. */
export async function resolveExportedAgentBindings(options: {
  artifactId: string
  skillContent: string
  userAgentsDir: string
  projectDir: string
}): Promise<ExportedAgentBinding[]> {
  const unsupportedDispatches = unsupportedAgentDispatchTypes(options.skillContent)
  if (unsupportedDispatches.length > 0) {
    throw new OwnedExportedAgentReferenceError(
      `Managed runs cannot immutably bind namespaced or invalid agent dispatches: ${unsupportedDispatches.join(', ')}.`,
    )
  }
  const slugs = unqualifiedAgentDispatchSlugs(options.skillContent)
  const declaredSlugs = parseBespokeAgentDeclaration(options.skillContent)
  if (declaredSlugs === null) {
    if (slugs.length === 0) return []
    throw new OwnedExportedAgentDeclarationError('This exported workflow predates bespoke-agent deployment metadata. Re-export it before running.')
  }
  const dispatched = new Set(slugs)
  if (declaredSlugs.some(slug => !dispatched.has(slug))) {
    throw new OwnedExportedAgentDeclarationError('The exported workflow declares a bespoke agent it does not dispatch.')
  }
  const declared = new Set(declaredSlugs)
  const agents: ExportedAgentBinding[] = []
  for (const slug of slugs) {
    const inspectAgent = async (filePath: string): Promise<AgentInspection> => {
      try {
        const stat = await fs.lstat(filePath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANAGED_SKILL_BYTES) return { status: 'invalid' }
        const content = await fs.readFile(filePath, 'utf-8')
        return {
          status: ownedExportedAgentId(content) === options.artifactId ? 'owned' : 'reference',
          contentHash: createHash('sha256').update(content).digest('hex'),
          content,
        }
      } catch (err) {
        return typeof err === 'object' && err !== null && 'code' in err
          && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'absent' }
          : { status: 'invalid' }
      }
    }

    const validDispatchName = (inspection: AgentInspection): boolean => {
      if (inspection.status !== 'owned' && inspection.status !== 'reference') return false
      try { return matter(inspection.content).data.name === slug } catch { return false }
    }

    const projectPath = path.join(options.projectDir, '.claude', 'agents', `${slug}.md`)
    const userPath = path.join(options.userAgentsDir, `${slug}.md`)
    const project = await inspectAgent(projectPath)
    if (!declared.has(slug)) {
      if (project.status === 'owned') {
        throw new OwnedExportedAgentDeclarationError(`Agent ${slug} is owned by this workflow but is not declared bespoke.`)
      }
      if (project.status === 'reference') {
        if (!validDispatchName(project)) throw new OwnedExportedAgentReferenceError(`Referenced project agent ${slug} is invalid.`)
        agents.push({ slug, scope: 'project', kind: 'reference', contentHash: project.contentHash, content: project.content })
        continue
      }
      if (project.status === 'invalid') throw new OwnedExportedAgentReferenceError(`Referenced project agent ${slug} cannot be read safely.`)
      if (project.status === 'absent') {
        const user = await inspectAgent(userPath)
        if (user.status === 'owned') {
          throw new OwnedExportedAgentDeclarationError(`Agent ${slug} is owned by this workflow but is not declared bespoke.`)
        }
        if (user.status === 'reference') {
          if (!validDispatchName(user)) throw new OwnedExportedAgentReferenceError(`Referenced user agent ${slug} is invalid.`)
          agents.push({ slug, scope: 'user', kind: 'reference', contentHash: user.contentHash, content: user.content })
        } else if (user.status === 'invalid') {
          throw new OwnedExportedAgentReferenceError(`Referenced user agent ${slug} cannot be read safely.`)
        } else {
          throw new OwnedExportedAgentReferenceError(`Referenced agent ${slug} is not installed in the selected project or user scope.`)
        }
      }
      continue
    }
    if (project.status !== 'absent') {
      if (project.status === 'owned') {
        if (!validDispatchName(project)) throw new OwnedExportedAgentMissingError(`Declared bespoke project agent ${slug} is invalid.`)
        agents.push({ slug, scope: 'project', kind: 'bespoke', contentHash: project.contentHash, content: project.content })
      } else {
        throw new OwnedExportedAgentCollisionError(`Project agent ${slug} shadows the declared bespoke agent.`)
      }
      continue
    }
    const user = await inspectAgent(userPath)
    if (user.status === 'owned') {
      if (!validDispatchName(user)) throw new OwnedExportedAgentMissingError(`Declared bespoke user agent ${slug} is invalid.`)
      agents.push({ slug, scope: 'user', kind: 'bespoke', contentHash: user.contentHash, content: user.content })
    } else {
      throw new OwnedExportedAgentMissingError(`Declared bespoke agent ${slug} is missing or no longer owned by this workflow.`)
    }
  }
  return agents
}

export function sameExportedAgentBindings(
  expected: ExportedAgentBinding[],
  actual: ExportedAgentBinding[],
): boolean {
  return expected.length === actual.length && expected.every((agent, index) => {
    const candidate = actual[index]
    return candidate?.slug === agent.slug
      && candidate.scope === agent.scope
      && candidate.kind === agent.kind
      && candidate.contentHash === agent.contentHash
  })
}

export function sameOwnedExportedSkill(
  expected: OwnedExportedSkill,
  actual: OwnedExportedSkill | null,
): boolean {
  return actual?.scope === expected.scope && actual.contentHash === expected.contentHash
}
