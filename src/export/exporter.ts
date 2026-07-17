import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import matter from 'gray-matter'
import type { CwcArtifactKind, CwcFile, CwcNode } from '../schema.js'
import { artifactKindOf, artifactTierOf } from '../schema.js'
import { agentSlug, currentArtifactSkillSlug } from '../slugify.js'
import { generateOrchestratorBody, collectNodeOverrides } from '../workflow/prose-generator.js'
import { resolveSkill, SkillResolution } from './skill-resolver.js'
import { buildAgentFileContent, buildManagedSkillContent, buildWorkflowSkillContent } from './file-writer.js'
import { detectConflict } from './conflict-detector.js'
import { withExportTargetLease } from './target-lease.js'
import { unqualifiedAgentDispatchSlugs } from './deployment-metadata.js'
import {
  finalizeFileDeletions,
  rollbackFileDeletions,
  stageReversibleFileDeletion,
  type ReversibleFileDeletion,
} from './file-transaction.js'

export type ExportTarget =
  | { type: 'project'; projectDir: string }
  | { type: 'user'; userDir?: string }

export interface ExportPaths {
  agentsDir: string
  skillsDir: string
}

export class ExportConflictError extends Error {
  constructor(message: string, readonly filePath: string) {
    super(message)
    this.name = 'ExportConflictError'
  }
}

export class InvalidArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArtifactError'
  }
}

export interface ExportOptions {
  /** Optional test/embedding override. Normal exports resolve this from the target. */
  skillsDir?: string
  userSkillsDir?: string
  /** Test hook after a complete temp write but before the final ownership check
   * and atomic rename. Never exposed by the HTTP export route. */
  beforeAtomicRename?: (filePath: string, tempPath: string) => Promise<void>
  /** Test/embedding hook at each live deployment commit boundary. */
  beforeDeploymentCommit?: (filePath: string) => Promise<void>
  /** Commit the recipe identity while deployment rollback bytes are retained.
   * A rejection must mean the recipe was not committed. */
  commitUpdatedCwc?: (updatedCwc: CwcFile) => Promise<void>
}

export interface ExportResult {
  updatedCwc: CwcFile
  warnings: string[]
  artifactKind: CwcArtifactKind
  artifactSlug: string
  written: string[]
  deleted: string[]
}

export interface ExportPreviewResult {
  files: { path: string; content: string }[]
  deletions: string[]
  warnings: string[]
  artifactKind: CwcArtifactKind
  artifactSlug: string
}

export const AGENT_OWNERSHIP_REGEX = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
export const WORKFLOW_OWNERSHIP_REGEX = /^<!-- cwc:workflow:[^:\s>]+ -->$/

interface PlannedFile {
  path: string
  content: string
  kind: 'agent' | 'skill'
}

interface ExportPlan {
  artifactKind: CwcArtifactKind
  artifactSlug: string
  files: PlannedFile[]
  warnings: string[]
  updatedNodes: CwcNode[]
  paths: ExportPaths
}

interface CleanupCandidate {
  path: string
  kind: 'agent' | 'skill'
}

interface CleanupInspection {
  owned: CleanupCandidate[]
  blocked: CleanupCandidate[]
  warnings: string[]
}

interface CleanupResult {
  deleted: string[]
  failed: CleanupCandidate[]
}

type PlannedDestinationSnapshot =
  | { exists: false }
  | { exists: true; content: string; mode: number }

interface StagedPlannedFile {
  file: PlannedFile
  previous: PlannedDestinationSnapshot
  tempPath: string
  backupPath: string
  backupReady: boolean
  committed: boolean
  preserveBackup: boolean
}

function isSafeOwnedSlug(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-z0-9-]+$/.test(value)
}

function isFsError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as NodeJS.ErrnoException).code === code
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function lstatIfExists(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath)
  } catch (err) {
    if (isFsError(err, 'ENOENT')) return null
    throw new ExportConflictError(`Could not inspect ${filePath}: ${errorMessage(err)}`, filePath)
  }
}

async function assertSafeDirectory(directory: string, subjectPath: string): Promise<void> {
  const stat = await lstatIfExists(directory)
  if (!stat) return
  if (stat.isSymbolicLink()) {
    throw new ExportConflictError(`Refusing to use symbolic-link export directory ${directory}.`, subjectPath)
  }
  if (!stat.isDirectory()) {
    throw new ExportConflictError(`Export directory ${directory} is not a directory.`, subjectPath)
  }
}

/** Ownership checks must distinguish a genuinely absent path from an existing path
 * that CWC cannot safely inspect. Treating EACCES as absence can overwrite a foreign,
 * write-only file without ever verifying its marker. */
async function readRegularFileForOwnership(filePath: string): Promise<string | null> {
  const stat = await lstatIfExists(filePath)
  if (!stat) return null
  if (stat.isSymbolicLink()) {
    throw new ExportConflictError(`Refusing to follow symbolic-link export target ${filePath}.`, filePath)
  }
  if (!stat.isFile()) {
    throw new ExportConflictError(`Export target ${filePath} is not a regular file.`, filePath)
  }
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    throw new ExportConflictError(`Could not verify ownership of ${filePath}: ${errorMessage(err)}`, filePath)
  }
}

/** Reference discovery is advisory, so an unreadable reference remains a warning rather
 * than blocking export. It must not be used for overwrite/delete authority. */
async function readOptionalReference(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, 'utf-8') } catch { return null }
}

export function resolveExportPaths(target: ExportTarget, opts?: { skillsDir?: string }): ExportPaths {
  if (target.type === 'project') {
    if (!target.projectDir || !path.isAbsolute(target.projectDir)) {
      throw new Error('projectDir must be an absolute path')
    }
    return {
      agentsDir: path.join(target.projectDir, '.claude', 'agents'),
      skillsDir: opts?.skillsDir ?? path.join(target.projectDir, '.claude', 'skills'),
    }
  }

  if (target.userDir && !path.isAbsolute(target.userDir)) {
    throw new Error('userDir must be an absolute path')
  }
  const userDir = target.userDir ?? os.homedir()
  return {
    agentsDir: path.join(userDir, '.claude', 'agents'),
    skillsDir: opts?.skillsDir ?? path.join(userDir, '.claude', 'skills'),
  }
}

async function resolveSkillWithOverrideInner(slug: string, userSkillsDir?: string): Promise<SkillResolution> {
  if (!slug.includes(':') && userSkillsDir) {
    const skillMdPath = path.join(userSkillsDir, slug, 'SKILL.md')
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { data } = matter(content)
      return { slug, description: typeof data.description === 'string' ? data.description : null, found: true }
    } catch {
      // Fall through to normal resolution
    }
  }
  return resolveSkill(slug)
}

export const resolveSkillWithOverride = resolveSkillWithOverrideInner

export function nodeExportedSlug(node: CwcNode): string | null {
  if (node.agentRef) return node.agentRef
  if (node.nodeType === 'gate') return null
  return agentSlug(node.agent.name)
}

export function applyExportedNodeSlugs(nodes: CwcNode[]): CwcNode[] {
  return nodes.map(node => ({ ...node, exportedSlug: nodeExportedSlug(node) }))
}

/** Local structural guard until the canonical versioned parser owns every ingress. */
export function validateExportableArtifact(cwc: CwcFile): CwcArtifactKind {
  if (!cwc || !cwc.meta || !Array.isArray(cwc.nodes) || !Array.isArray(cwc.edges)) {
    throw new InvalidArtifactError('Artifact must contain meta, nodes, and edges.')
  }

  let kind: CwcArtifactKind
  let tier: ReturnType<typeof artifactTierOf>
  try {
    kind = artifactKindOf(cwc)
    tier = artifactTierOf(cwc)
  } catch (err) {
    throw new InvalidArtifactError(err instanceof Error ? err.message : String(err))
  }

  if (kind === 'workflow') {
    if (tier !== 'workflow') throw new InvalidArtifactError(`A workflow artifact cannot use the ${tier} tier.`)
    return kind
  }

  if (tier === 'workflow') throw new InvalidArtifactError('A skill artifact cannot use the workflow tier.')
  if (cwc.nodes.length !== 1) {
    throw new InvalidArtifactError('A skill artifact must contain exactly one bespoke node.')
  }
  if (cwc.edges.length !== 0) {
    throw new InvalidArtifactError('A skill artifact cannot contain edges.')
  }

  const node = cwc.nodes[0]
  if (!node || node.nodeType === 'gate' || node.agentRef) {
    throw new InvalidArtifactError('A skill artifact must contain one bespoke non-gate node.')
  }
  if (!node.agent || typeof node.agent.name !== 'string' || node.agent.name.trim() === '') {
    throw new InvalidArtifactError('A skill artifact needs a name before export.')
  }
  if (typeof node.agent.description !== 'string' || node.agent.description.trim() === '') {
    throw new InvalidArtifactError('A skill artifact needs a description before export.')
  }
  if (typeof node.agent.systemPrompt !== 'string' || node.agent.systemPrompt.trim() === '') {
    throw new InvalidArtifactError('A skill artifact needs a body before export.')
  }
  return kind
}

async function planExport(cwc: CwcFile, target: ExportTarget, opts: ExportOptions): Promise<ExportPlan> {
  const artifactKind = validateExportableArtifact(cwc)
  const artifactSlug = currentArtifactSkillSlug(cwc)
  const paths = resolveExportPaths(target, { skillsDir: opts.skillsDir })
  const workflowId = cwc.meta.id
  const allowModelInvocation = cwc.meta.modelInvocation === 'auto'

  if (artifactKind === 'skill') {
    const node = cwc.nodes[0]
    const content = buildManagedSkillContent(
      artifactSlug,
      node.agent.description,
      node.agent.systemPrompt!,
      workflowId,
      allowModelInvocation,
    )
    return {
      artifactKind,
      artifactSlug,
      paths,
      warnings: [],
      updatedNodes: [{ ...node, exportedSlug: null }],
      files: [{ path: path.join(paths.skillsDir, artifactSlug, 'SKILL.md'), content, kind: 'skill' }],
    }
  }

  const warnings: string[] = []
  const currentBespokeSlugs = new Map<string, CwcNode>()
  for (const node of cwc.nodes) {
    const slug = nodeExportedSlug(node)
    if (slug === null || node.agentRef) continue
    const existing = currentBespokeSlugs.get(slug)
    if (existing) {
      throw new ExportConflictError(
        `Agents "${existing.agent.name}" and "${node.agent.name}" both export to ${slug}. Rename one agent before exporting.`,
        path.join(paths.agentsDir, `${slug}.md`),
      )
    }
    currentBespokeSlugs.set(slug, node)
  }

  const updatedNodes = applyExportedNodeSlugs(cwc.nodes)
  const files: PlannedFile[] = []
  for (const node of cwc.nodes) {
    if (node.agentRef) {
      if (currentBespokeSlugs.has(node.agentRef)) {
        throw new ExportConflictError(
          `Referenced agent ${node.agentRef} has the same dispatch slug as a bespoke agent. Rename the bespoke agent or choose a different reference.`,
          path.join(paths.agentsDir, `${node.agentRef}.md`),
        )
      }
      for (const skillSlug of node.agent.skills ?? []) {
        const resolved = await resolveSkillWithOverrideInner(skillSlug, opts.userSkillsDir)
        if (!resolved.found) warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
      }
      if (await readOptionalReference(path.join(paths.agentsDir, `${node.agentRef}.md`)) === null) {
        warnings.push(`Referenced agent not found: ${node.agentRef} — install it on the target machine`)
      }
      continue
    }
    if (node.nodeType === 'gate') continue

    const slug = agentSlug(node.agent.name)
    const resolvedSkills: SkillResolution[] = []
    for (const skillSlug of node.agent.skills ?? []) {
      const resolved = await resolveSkillWithOverrideInner(skillSlug, opts.userSkillsDir)
      if (!resolved.found) warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
      resolvedSkills.push(resolved)
    }
    files.push({
      path: path.join(paths.agentsDir, `${slug}.md`),
      content: buildAgentFileContent(node, resolvedSkills, workflowId, slug),
      kind: 'agent',
    })
  }

  const observabilityEnabled = cwc.meta.observability?.enabled !== false
  const orchestratorBody = generateOrchestratorBody(
    updatedNodes,
    cwc.edges,
    cwc.meta.name,
    collectNodeOverrides(cwc.nodes),
    observabilityEnabled ? { observability: { workflowId, workflowSlug: artifactSlug } } : {},
  )
  const dispatchedSlugs = new Set(unqualifiedAgentDispatchSlugs(orchestratorBody))
  const bespokeAgentSlugs = [...currentBespokeSlugs.keys()].filter(slug => dispatchedSlugs.has(slug))
  files.push({
    path: path.join(paths.skillsDir, artifactSlug, 'SKILL.md'),
    content: buildWorkflowSkillContent(
      artifactSlug,
      cwc.meta.description,
      orchestratorBody,
      workflowId,
      allowModelInvocation,
      bespokeAgentSlugs,
    ),
    kind: 'skill',
  })

  return { artifactKind, artifactSlug, files, warnings, updatedNodes, paths }
}

function cleanupCandidates(cwc: CwcFile, plan: ExportPlan): CleanupCandidate[] {
  const candidates = new Map<string, CleanupCandidate>()
  const plannedPaths = new Set(plan.files.map(file => file.path))
  const add = (candidate: CleanupCandidate): void => {
    if (!plannedPaths.has(candidate.path)) candidates.set(candidate.path, candidate)
  }

  for (const slug of cwc.meta.pendingExportCleanup?.agentSlugs ?? []) {
    if (isSafeOwnedSlug(slug)) add({ path: path.join(plan.paths.agentsDir, `${slug}.md`), kind: 'agent' })
  }

  if (plan.artifactKind === 'skill') {
    for (const node of cwc.nodes) {
      const oldSlugs = new Set([node.exportedSlug, node.agent?.name ? agentSlug(node.agent.name) : null])
      for (const slug of oldSlugs) {
        if (isSafeOwnedSlug(slug)) add({ path: path.join(plan.paths.agentsDir, `${slug}.md`), kind: 'agent' })
      }
    }
  } else {
    for (const node of cwc.nodes) {
      const currentSlug = nodeExportedSlug(node)
      if (isSafeOwnedSlug(node.exportedSlug) && node.exportedSlug !== currentSlug) {
        add({ path: path.join(plan.paths.agentsDir, `${node.exportedSlug}.md`), kind: 'agent' })
      }
    }
  }

  const previousSkillSlugs = new Set<string>([
    ...(cwc.meta.pendingExportCleanup?.skillSlugs ?? []),
    ...(cwc.meta.exportedWorkflowSlug ? [cwc.meta.exportedWorkflowSlug] : []),
  ])
  for (const previousSkillSlug of previousSkillSlugs) {
    if (isSafeOwnedSlug(previousSkillSlug) && previousSkillSlug !== plan.artifactSlug) {
      add({ path: path.join(plan.paths.skillsDir, previousSkillSlug, 'SKILL.md'), kind: 'skill' })
    }
  }
  return [...candidates.values()]
}

function ownershipRegex(kind: CleanupCandidate['kind']): RegExp {
  return kind === 'agent' ? AGENT_OWNERSHIP_REGEX : WORKFLOW_OWNERSHIP_REGEX
}

async function assertNoWriteConflict(cwc: CwcFile, plan: ExportPlan, file: PlannedFile): Promise<void> {
  const directories = file.kind === 'skill'
    ? [plan.paths.skillsDir, path.dirname(file.path)]
    : [plan.paths.agentsDir]
  for (const directory of directories) await assertSafeDirectory(directory, file.path)

  const existing = await readRegularFileForOwnership(file.path)
  if (existing === null) return
  const regex = file.kind === 'agent' ? AGENT_OWNERSHIP_REGEX : WORKFLOW_OWNERSHIP_REGEX
  const status = detectConflict(existing, regex, cwc.meta.id)
  if (status === 'owned') return
  if (file.kind === 'agent') {
    throw new ExportConflictError(
      `Agent file at ${file.path} was not created by this workflow. Rename the agent or remove the file before exporting.`,
      file.path,
    )
  }
  throw new ExportConflictError(
    `Skill at ${file.path} was not created by this workflow. Rename the artifact or remove the existing skill before exporting.`,
    file.path,
  )
}

async function assertNoWriteConflicts(cwc: CwcFile, plan: ExportPlan): Promise<void> {
  for (const file of plan.files) await assertNoWriteConflict(cwc, plan, file)
}

function transactionSiblingPath(cwc: CwcFile, file: PlannedFile, extension: 'tmp' | 'bak'): string {
  const suffix = createHash('sha256')
    .update(`${cwc.meta.id}\0${file.path}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(
    path.dirname(file.path),
    `.${path.basename(file.path)}.cwc-${suffix}-${randomUUID()}.${extension}`,
  )
}

async function snapshotPlannedDestination(
  cwc: CwcFile,
  plan: ExportPlan,
  file: PlannedFile,
): Promise<PlannedDestinationSnapshot> {
  await assertNoWriteConflict(cwc, plan, file)
  const content = await readRegularFileForOwnership(file.path)
  if (content === null) return { exists: false }
  const stat = await lstatIfExists(file.path)
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new ExportConflictError(`Export target ${file.path} changed while CWC was preparing it.`, file.path)
  }
  return { exists: true, content, mode: Number(stat.mode) & 0o777 }
}

async function assertDestinationSnapshot(
  file: PlannedFile,
  expected: PlannedDestinationSnapshot,
): Promise<void> {
  const content = await readRegularFileForOwnership(file.path)
  if (!expected.exists) {
    if (content !== null) {
      throw new ExportConflictError(`Export target ${file.path} appeared while CWC was preparing the deployment.`, file.path)
    }
    return
  }
  const stat = await lstatIfExists(file.path)
  if (content !== expected.content || !stat?.isFile() || stat.isSymbolicLink()
    || (Number(stat.mode) & 0o777) !== expected.mode) {
    throw new ExportConflictError(`Export target ${file.path} changed while CWC was preparing the deployment.`, file.path)
  }
}

async function stagePlannedFile(
  cwc: CwcFile,
  file: PlannedFile,
  previous: PlannedDestinationSnapshot,
  opts: ExportOptions,
): Promise<StagedPlannedFile> {
  await fs.mkdir(path.dirname(file.path), { recursive: true })
  const tempPath = transactionSiblingPath(cwc, file, 'tmp')
  const backupPath = transactionSiblingPath(cwc, file, 'bak')
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  let staged = false

  try {
    handle = await fs.open(tempPath, 'wx', previous.exists ? previous.mode : 0o666)
    await handle.writeFile(file.content, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    if (previous.exists) await fs.chmod(tempPath, previous.mode)

    await opts.beforeAtomicRename?.(file.path, tempPath)
    staged = true
    return { file, previous, tempPath, backupPath, backupReady: false, committed: false, preserveBackup: false }
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    if (!staged) await fs.unlink(tempPath).catch(() => undefined)
  }
}

async function rollbackCommittedFile(staged: StagedPlannedFile): Promise<void> {
  const current = await readRegularFileForOwnership(staged.file.path)
  if (staged.previous.exists) {
    if (current !== null && current !== staged.file.content) {
      throw new Error(`Export target ${staged.file.path} changed before rollback; its backup remains at ${staged.backupPath}.`)
    }
    await fs.rename(staged.backupPath, staged.file.path)
    staged.backupReady = false
    staged.committed = false
    return
  }
  if (current === null) {
    staged.committed = false
    return
  }
  if (current !== staged.file.content) {
    throw new Error(`Export target ${staged.file.path} changed before rollback and was preserved.`)
  }
  await fs.unlink(staged.file.path)
  staged.committed = false
}

/** Stage every complete file before touching the live deployment. Existing files
 * are retained as same-directory backups until every rename commits; a later
 * failure restores all earlier paths in reverse order. */
async function writePlannedDeploymentAtomically(
  cwc: CwcFile,
  plan: ExportPlan,
  opts: ExportOptions,
  warnings: string[],
  completeDeployment: () => Promise<void> = async () => {},
): Promise<void> {
  const snapshots: PlannedDestinationSnapshot[] = []
  for (const file of plan.files) snapshots.push(await snapshotPlannedDestination(cwc, plan, file))

  const staged: StagedPlannedFile[] = []
  try {
    for (let index = 0; index < plan.files.length; index++) {
      staged.push(await stagePlannedFile(cwc, plan.files[index], snapshots[index], opts))
    }
    // Hooks and staging are await boundaries. Validate every destination before
    // the first live path changes, so a failed preflight publishes nothing.
    for (const entry of staged) await assertDestinationSnapshot(entry.file, entry.previous)

    const committed: StagedPlannedFile[] = []
    try {
      for (const entry of staged) {
        // Revalidate each path again at its commit boundary. The export lease
        // serializes cooperating mutations; this additionally catches editors.
        await assertDestinationSnapshot(entry.file, entry.previous)
        await opts.beforeDeploymentCommit?.(entry.file.path)
        if (entry.previous.exists) {
          // A same-directory hard link preserves the exact old inode without a
          // window where the runnable path is absent. A crash before commit leaves
          // the old deployment live; a crash after commit leaves a recovery copy.
          await fs.link(entry.file.path, entry.backupPath)
          entry.backupReady = true
        }
        try {
          await fs.rename(entry.tempPath, entry.file.path)
        } catch (err) {
          if (entry.backupReady) {
            try {
              await fs.unlink(entry.backupPath)
              entry.backupReady = false
            } catch {
              // The original destination is still live. Preserve the redundant
              // backup for manual cleanup instead of obscuring the commit error.
              entry.preserveBackup = true
            }
          }
          throw err
        }
        entry.committed = true
        committed.push(entry)
      }
      // Keep every old-byte backup until the recipe authority and obsolete-file
      // cleanup have committed. If either rejects, this catch restores the prior
      // runnable deployment instead of leaving deployment and recipe split.
      await completeDeployment()
    } catch (err) {
      const rollbackErrors: string[] = []
      for (const entry of committed.reverse()) {
        try {
          await rollbackCommittedFile(entry)
        } catch (rollbackErr) {
          entry.preserveBackup = entry.backupReady
          rollbackErrors.push(errorMessage(rollbackErr))
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${errorMessage(err)} Deployment rollback was incomplete: ${rollbackErrors.join(' ')}`)
      }
      throw err
    }

    for (const entry of staged) {
      if (!entry.backupReady) continue
      try {
        await fs.unlink(entry.backupPath)
        entry.backupReady = false
      } catch (err) {
        entry.preserveBackup = true
        warnings.push(`The deployment succeeded, but its previous-byte backup could not be removed: ${entry.backupPath} (${errorMessage(err)})`)
      }
    }
  } finally {
    for (const entry of staged) {
      await fs.unlink(entry.tempPath).catch(() => undefined)
      // Keep a backup when rollback was incomplete. It is the only recovery copy.
      if (entry.preserveBackup || (entry.backupReady && !entry.committed)) continue
      await fs.unlink(entry.backupPath).catch(() => undefined)
    }
  }
}

async function inspectCleanupCandidates(cwc: CwcFile, plan: ExportPlan): Promise<CleanupInspection> {
  const owned: CleanupCandidate[] = []
  const blocked: CleanupCandidate[] = []
  const warnings: string[] = []
  for (const candidate of cleanupCandidates(cwc, plan)) {
    try {
      await assertSafeDirectory(path.dirname(candidate.path), candidate.path)
      const content = await readRegularFileForOwnership(candidate.path)
      if (content === null) continue
      const status = detectConflict(content, ownershipRegex(candidate.kind), cwc.meta.id)
      if (status === 'owned') {
        owned.push(candidate)
      } else {
        warnings.push(`Preserved obsolete ${candidate.path} because it is not owned by this artifact.`)
      }
    } catch (err) {
      blocked.push(candidate)
      warnings.push(`Could not safely inspect obsolete ${candidate.path}; it was left in place: ${errorMessage(err)}`)
    }
  }
  return { owned, blocked, warnings }
}

async function warnForPreservedSkillAssets(candidate: CleanupCandidate, warnings: string[]): Promise<void> {
  if (candidate.kind !== 'skill') return
  const skillDir = path.dirname(candidate.path)
  const entries = await fs.readdir(skillDir).catch(() => [] as string[])
  const extras = entries.filter(entry => entry !== 'SKILL.md')
  if (extras.length > 0) {
    warnings.push(`Preserved ${extras.length} unowned file${extras.length === 1 ? '' : 's'} in ${skillDir}`)
  }
}

async function cleanupOwnedFiles(
  cwc: CwcFile,
  candidates: CleanupCandidate[],
  warnings: string[],
  completeCleanup: (result: CleanupResult) => Promise<void> = async () => {},
): Promise<CleanupResult> {
  const deleted: string[] = []
  const failed: CleanupCandidate[] = []
  const stagedDeletions: ReversibleFileDeletion[] = []
  try {
    for (const candidate of candidates) {
      try {
        // Ownership may have changed while new files were being written. Re-read it
        // immediately before unlinking rather than relying on the earlier preview.
        await assertSafeDirectory(path.dirname(candidate.path), candidate.path)
        const content = await readRegularFileForOwnership(candidate.path)
        if (content === null) continue
        if (detectConflict(content, ownershipRegex(candidate.kind), cwc.meta.id) !== 'owned') {
          warnings.push(`Preserved obsolete ${candidate.path} because it is no longer owned by this artifact.`)
          continue
        }
        const backupDirectory = candidate.kind === 'skill'
          ? path.dirname(path.dirname(candidate.path))
          : path.dirname(candidate.path)
        stagedDeletions.push(await stageReversibleFileDeletion(candidate.path, content, backupDirectory))
        deleted.push(candidate.path)
        if (candidate.kind === 'skill') {
          try {
            await fs.rmdir(path.dirname(candidate.path))
          } catch (err) {
            if (!isFsError(err, 'ENOENT') && !isFsError(err, 'ENOTEMPTY') && !isFsError(err, 'EEXIST')) {
              warnings.push(`Could not remove empty skill directory ${path.dirname(candidate.path)}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }
      } catch (err) {
        if (!isFsError(err, 'ENOENT')) {
          failed.push(candidate)
          warnings.push(`Could not remove obsolete ${candidate.path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    const result = { deleted, failed }
    await completeCleanup(result)
    await finalizeFileDeletions(stagedDeletions, warning => warnings.push(warning))
    return result
  } catch (err) {
    try {
      await rollbackFileDeletions(stagedDeletions)
    } catch (rollbackError) {
      throw new Error(`${errorMessage(err)} ${errorMessage(rollbackError)}`)
    }
    throw err
  }
}

function reconcilePendingCleanupIdentity(
  cwc: CwcFile,
  plan: ExportPlan,
  pending: CleanupCandidate[],
): Pick<CwcFile, 'nodes'> & {
  exportedWorkflowSlug: string
  pendingExportCleanup: CwcFile['meta']['pendingExportCleanup']
} {
  const pendingPaths = new Set(pending.map(candidate => candidate.path))
  const previousNodes = new Map(cwc.nodes.map(node => [node.id, node]))
  const nodes = plan.updatedNodes.map(node => {
    const previous = previousNodes.get(node.id)
    if (!previous) return node

    // An exported slug is the retry authority for an obsolete agent path. Prefer
    // the persisted identity; the name-derived path remains reproducible for old
    // files that predate exportedSlug bookkeeping.
    const retrySlugs = [previous.exportedSlug]
    if (plan.artifactKind === 'skill' && previous.agent?.name) {
      retrySlugs.push(agentSlug(previous.agent.name))
    }
    const retrySlug = retrySlugs.find(slug => isSafeOwnedSlug(slug)
      && pendingPaths.has(path.join(plan.paths.agentsDir, `${slug}.md`)))
    return retrySlug ? { ...node, exportedSlug: retrySlug } : node
  })

  const pendingSkillSlugs = pending
    .filter(candidate => candidate.kind === 'skill')
    .map(candidate => path.basename(path.dirname(candidate.path)))
    .filter(isSafeOwnedSlug)
    .sort()
  const pendingAgentSlugs = pending
    .filter(candidate => candidate.kind === 'agent')
    .map(candidate => path.basename(candidate.path, '.md'))
    .filter(isSafeOwnedSlug)
    .sort()
  const skillSlugs = [...new Set(pendingSkillSlugs)]
  const agentSlugs = [...new Set(pendingAgentSlugs)]
  return {
    nodes,
    exportedWorkflowSlug: plan.artifactSlug,
    pendingExportCleanup: skillSlugs.length > 0 || agentSlugs.length > 0
      ? {
          ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
          ...(agentSlugs.length > 0 ? { agentSlugs } : {}),
        }
      : undefined,
  }
}

export async function buildExportPreview(
  cwc: CwcFile,
  target: ExportTarget,
  opts: ExportOptions = {},
): Promise<ExportPreviewResult> {
  const plan = await planExport(cwc, target, opts)
  // Preview performs the same read-only safety and ownership preflight as export. It
  // creates no directories and writes no files.
  await assertNoWriteConflicts(cwc, plan)
  const cleanup = await inspectCleanupCandidates(cwc, plan)
  const warnings = [...plan.warnings, ...cleanup.warnings]
  for (const candidate of cleanup.owned) await warnForPreservedSkillAssets(candidate, warnings)
  return {
    files: plan.files.map(({ path: filePath, content }) => ({ path: filePath, content })),
    deletions: cleanup.owned.map(candidate => candidate.path),
    warnings,
    artifactKind: plan.artifactKind,
    artifactSlug: plan.artifactSlug,
  }
}

export async function exportWorkflow(
  cwc: CwcFile,
  target: ExportTarget,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const leasePaths = resolveExportPaths(target, { skillsDir: opts.skillsDir })
  return withExportTargetLease([path.dirname(leasePaths.agentsDir), leasePaths.skillsDir], async () => {
    const plan = await planExport(cwc, target, opts)

    // Resolve all hard conflicts before writing or removing anything. This keeps a rename or
    // kind transition from destroying its previous runnable deployment on a destination conflict.
    await assertNoWriteConflicts(cwc, plan)
    const cleanup = await inspectCleanupCandidates(cwc, plan)
    const warnings = [...plan.warnings, ...cleanup.warnings]
    for (const candidate of cleanup.owned) await warnForPreservedSkillAssets(candidate, warnings)

    let exportResult: ExportResult | null = null
    await writePlannedDeploymentAtomically(cwc, plan, opts, warnings, async () => {
      // New files are safely in place before obsolete owned paths are removed. Every
      // deletion retains exact rollback bytes until the recipe CAS below succeeds.
      await cleanupOwnedFiles(cwc, cleanup.owned, warnings, async cleanupResult => {
        const pendingCleanup = [...cleanup.blocked, ...cleanupResult.failed]
        if (pendingCleanup.length > 0) {
          warnings.push('Obsolete export paths were retained for a later cleanup retry.')
        }
        const reconciledIdentity = reconcilePendingCleanupIdentity(cwc, plan, pendingCleanup)
        const updatedCwc: CwcFile = {
          ...cwc,
          // The deployed skill identity always describes newly written runnable output.
          // Obsolete retry paths have separate, path-specific metadata.
          nodes: reconciledIdentity.nodes,
          meta: {
            ...cwc.meta,
            updated: new Date().toISOString(),
            exportedWorkflowSlug: reconciledIdentity.exportedWorkflowSlug,
            pendingExportCleanup: reconciledIdentity.pendingExportCleanup,
          },
        }

        await opts.commitUpdatedCwc?.(updatedCwc)
        exportResult = {
          updatedCwc,
          warnings,
          artifactKind: plan.artifactKind,
          artifactSlug: plan.artifactSlug,
          written: plan.files.map(file => file.path),
          deleted: cleanupResult.deleted,
        }
      })
    })
    if (!exportResult) throw new Error('Deployment completed without committing recipe authority.')
    return exportResult
  })
}
