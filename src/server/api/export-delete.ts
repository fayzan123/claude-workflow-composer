import { Router as createRouter } from 'express'
import {
  AGENT_OWNERSHIP_REGEX,
  ExportConflictError,
  InvalidArtifactError,
  resolveExportPaths,
  WORKFLOW_OWNERSHIP_REGEX,
  type ExportTarget,
} from '../../export/exporter.js'
import type { CwcFile } from '../../schema.js'
import { artifactKindOf } from '../../schema.js'
import { detectConflict } from '../../export/conflict-detector.js'
import { agentSlug, currentArtifactSkillSlug, workflowSkillSlug, slugify } from '../../slugify.js'
import { withExportTargetLease } from '../../export/target-lease.js'
import {
  finalizeFileDeletions,
  rollbackFileDeletions,
  stageReversibleFileDeletion,
  type ReversibleFileDeletion,
} from '../../export/file-transaction.js'
import {
  isWorkflowRevision,
  readPersistedWorkflow,
  replaceWorkflowFileAtomically,
  serializedWorkflow,
  workflowRevision,
  WorkflowUpdateConflict,
  type WorkflowMutationCoordinator,
} from './workflows.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function isFsError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as NodeJS.ErrnoException).code === code
}

async function readRegularOwnedTarget(filePath: string): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(filePath)
  } catch (err) {
    if (isFsError(err, 'ENOENT')) return null
    throw new ExportConflictError(`Could not inspect export target ${filePath}: ${err instanceof Error ? err.message : String(err)}`, filePath)
  }
  if (stat.isSymbolicLink()) {
    throw new ExportConflictError(`Refusing to follow symbolic-link export target ${filePath}.`, filePath)
  }
  if (!stat.isFile()) {
    throw new ExportConflictError(`Export target ${filePath} is not a regular file.`, filePath)
  }
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    throw new ExportConflictError(`Could not verify ownership of ${filePath}: ${err instanceof Error ? err.message : String(err)}`, filePath)
  }
}

async function assertRegularDirectory(directory: string, subjectPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(directory)
  } catch (err) {
    if (isFsError(err, 'ENOENT')) return false
    throw new ExportConflictError(`Could not inspect export directory ${directory}: ${err instanceof Error ? err.message : String(err)}`, subjectPath)
  }
  if (stat.isSymbolicLink()) {
    throw new ExportConflictError(`Refusing to use symbolic-link export directory ${directory}.`, subjectPath)
  }
  if (!stat.isDirectory()) {
    throw new ExportConflictError(`Export directory ${directory} is not a directory.`, subjectPath)
  }
  return true
}

function safeSlug(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-z0-9-]+$/.test(value)
}

export interface DeleteExportResult {
  deleted: string[]
  skipped: string[]
  notFound: string[]
}

export interface AuthorizedDeleteExportResult extends DeleteExportResult {
  updatedCwc: CwcFile
  recipeRevision: string
}

export interface DeleteExportOptions {
  /** Commit cleared recipe identity while exact deployment rollback bytes remain. */
  commitUpdatedCwc?: (result: DeleteExportResult) => Promise<void>
}

/** Delete only files whose final ownership marker names this CWC artifact. */
async function deleteExportUnlocked(
  cwc: CwcFile,
  target: ExportTarget,
  opts: DeleteExportOptions,
): Promise<DeleteExportResult> {
  let artifactKind: ReturnType<typeof artifactKindOf>
  try { artifactKind = artifactKindOf(cwc) } catch (err) {
    throw new InvalidArtifactError(err instanceof Error ? err.message : String(err))
  }

  const workflowId = cwc.meta.id
  const { agentsDir, skillsDir } = resolveExportPaths(target)
  const deleted: string[] = []
  const skipped: string[] = []
  const notFound: string[] = []
  const stagedDeletions: ReversibleFileDeletion[] = []

  try {
    const agentPaths = new Map<string, boolean>()
    const addAgentPath = (slug: string | null | undefined, reportMissing: boolean): void => {
      if (!safeSlug(slug)) return
      const filePath = path.join(agentsDir, `${slug}.md`)
      agentPaths.set(filePath, (agentPaths.get(filePath) ?? false) || reportMissing)
    }
    for (const node of cwc.nodes) {
      if (node.agentRef || node.nodeType === 'gate') continue
      if (artifactKind === 'skill') {
        // A partially-completed workflow-to-skill transition may retain the old
        // agent slug for retry. Name derivation also covers version-1/manual
        // transitions that predate exportedSlug bookkeeping; because it is only a
        // compatibility probe, its absence is not reported as a failed cleanup.
        addAgentPath(node.exportedSlug, true)
        addAgentPath(agentSlug(node.agent.name), false)
      } else {
        // exportedSlug may intentionally retain an obsolete agent cleanup retry.
        // Also probe the current name-derived deployment, without reporting its
        // speculative absence when a distinct persisted identity exists.
        addAgentPath(node.exportedSlug, true)
        addAgentPath(agentSlug(node.agent.name), node.exportedSlug === null)
      }
    }
    for (const slug of cwc.meta.pendingExportCleanup?.agentSlugs ?? []) addAgentPath(slug, true)

    for (const [agentPath, reportMissing] of agentPaths) {
      if (!await assertRegularDirectory(path.dirname(agentPath), agentPath)) {
        if (reportMissing) notFound.push(agentPath)
        continue
      }
      const content = await readRegularOwnedTarget(agentPath)
      if (content === null) {
        if (reportMissing) notFound.push(agentPath)
        continue
      }
      if (detectConflict(content, AGENT_OWNERSHIP_REGEX, workflowId) === 'owned') {
        const latest = await readRegularOwnedTarget(agentPath)
        if (latest === null) {
          if (reportMissing) notFound.push(agentPath)
          continue
        }
        if (detectConflict(latest, AGENT_OWNERSHIP_REGEX, workflowId) !== 'owned') {
          skipped.push(agentPath)
          continue
        }
        stagedDeletions.push(await stageReversibleFileDeletion(agentPath, latest))
        deleted.push(agentPath)
      } else {
        skipped.push(agentPath)
      }
    }

    // Include persisted identity first, plus current and legacy derivations. Checking every
    // candidate is safe because the ownership marker remains the final authority, and it also
    // cleans up a same-target rename/kind-transition orphan from older CWC versions.
    const skillSlugs = new Set<string>()
    const addSkillSlug = (slug: string | null | undefined): void => {
      if (safeSlug(slug)) skillSlugs.add(slug)
    }
    addSkillSlug(cwc.meta.exportedWorkflowSlug)
    for (const slug of cwc.meta.pendingExportCleanup?.skillSlugs ?? []) addSkillSlug(slug)
    addSkillSlug(currentArtifactSkillSlug(cwc))
    addSkillSlug(workflowSkillSlug(cwc.meta.name))
    addSkillSlug(slugify(cwc.meta.name))

    for (const slug of skillSlugs) {
      const skillDir = path.join(skillsDir, slug)
      const skillFilePath = path.join(skillDir, 'SKILL.md')
      if (!await assertRegularDirectory(skillDir, skillFilePath)) continue
      const skillContent = await readRegularOwnedTarget(skillFilePath)
      if (skillContent === null) continue
      if (detectConflict(skillContent, WORKFLOW_OWNERSHIP_REGEX, workflowId) !== 'owned') {
        skipped.push(skillFilePath)
        continue
      }

      const latestSkillContent = await readRegularOwnedTarget(skillFilePath)
      if (latestSkillContent === null) continue
      if (detectConflict(latestSkillContent, WORKFLOW_OWNERSHIP_REGEX, workflowId) !== 'owned') {
        skipped.push(skillFilePath)
        continue
      }

      stagedDeletions.push(await stageReversibleFileDeletion(skillFilePath, latestSkillContent, skillsDir))
      try {
        await fs.rmdir(skillDir)
        deleted.push(skillDir)
      } catch (err) {
        deleted.push(skillFilePath)
        if (isFsError(err, 'ENOTEMPTY') || isFsError(err, 'EEXIST')) skipped.push(skillDir)
        else if (!isFsError(err, 'ENOENT')) throw err
      }
    }

    const result = { deleted, skipped, notFound }
    await opts.commitUpdatedCwc?.(result)
    await finalizeFileDeletions(stagedDeletions)
    return result
  } catch (err) {
    try {
      await rollbackFileDeletions(stagedDeletions)
    } catch (rollbackError) {
      const original = err instanceof Error ? err.message : String(err)
      const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`${original} ${rollback}`)
    }
    throw err
  }
}

export async function deleteExport(
  cwc: CwcFile,
  target: ExportTarget,
  opts: DeleteExportOptions = {},
): Promise<DeleteExportResult> {
  const { agentsDir, skillsDir } = resolveExportPaths(target)
  return withExportTargetLease(
    [path.dirname(agentsDir), skillsDir],
    () => deleteExportUnlocked(cwc, target, opts),
  )
}

export interface ExportDeleteRouterOptions {
  mutations: WorkflowMutationCoordinator
  onSaved?: () => void | Promise<void>
}

function withoutExportIdentity(cwc: CwcFile): CwcFile {
  return {
    ...cwc,
    meta: {
      ...cwc.meta,
      exportedWorkflowSlug: undefined,
      pendingExportCleanup: undefined,
    },
    nodes: cwc.nodes.map(node => ({ ...node, exportedSlug: null })),
  }
}

export function exportDeleteRouter(config: ExportDeleteRouterOptions) {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target, workflowPath, expectedRevision } = req.body as {
      cwcFile: CwcFile
      target: ExportTarget
      workflowPath?: string
      expectedRevision?: string
    }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (typeof workflowPath !== 'string' || !isWorkflowRevision(expectedRevision)) {
      return void res.status(409).json({ error: 'Current workflow path and revision are required. Reload this recipe before deleting its export.' })
    }
    const resolvedWorkflowPath = config.mutations.resolveWorkflowPath(workflowPath)
    if (!resolvedWorkflowPath) {
      return void res.status(403).json({ error: 'Workflow path is outside the workflows directory.' })
    }
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) return void res.status(400).json({ error: 'userDir must be an absolute path' })
    try {
      const result = await config.mutations.withPathLeases([resolvedWorkflowPath], async (): Promise<AuthorizedDeleteExportResult> => {
        const persisted = await readPersistedWorkflow(resolvedWorkflowPath, cwcFile.meta.id)
        if (persisted.revision !== expectedRevision) {
          throw new WorkflowUpdateConflict('Workflow changed in another editor. Reload before deleting its export.')
        }
        if (workflowRevision(serializedWorkflow(cwcFile)) !== expectedRevision) {
          throw new WorkflowUpdateConflict('Delete snapshot does not match the saved recipe. Save it again before deleting its export.')
        }

        const updatedCwc = withoutExportIdentity(cwcFile)
        let recipeRevision = ''
        const deleted = await deleteExport(cwcFile, target, {
          commitUpdatedCwc: async () => {
            await replaceWorkflowFileAtomically(resolvedWorkflowPath, updatedCwc, persisted.mode, {
              expectedRevision: persisted.revision,
            })
            recipeRevision = workflowRevision(serializedWorkflow(updatedCwc))
          },
        })
        if (!recipeRevision) throw new Error('Export deletion completed without persisting recipe authority.')
        try { await config.onSaved?.() } catch { /* deployment and recipe already committed */ }
        return { ...deleted, updatedCwc, recipeRevision }
      })
      res.json(result)
    } catch (err) {
      if (err instanceof ExportConflictError) return void res.status(409).json({ error: err.message, path: err.filePath })
      if (err instanceof InvalidArtifactError) return void res.status(400).json({ error: err.message })
      if (isFsError(err, 'ENOENT')) return void res.status(404).json({ error: 'Workflow no longer exists. Reload before deleting its export.' })
      if (err instanceof WorkflowUpdateConflict) return void res.status(409).json({ error: err.message })
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
