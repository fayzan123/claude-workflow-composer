import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { artifactKindOf, artifactTierOf, type CwcFile } from '../../schema.js'
import { slugify } from '../../slugify.js'

export interface WorkflowDeleteLease {
  reason: string | null
  release(): void
}

export type WorkflowExportCleaner = (workflow: CwcFile) => Promise<unknown>

export class WorkflowUpdateConflict extends Error {}

export interface PersistedWorkflow {
  content: CwcFile
  mode: number
  revision: string
}

export interface AtomicWorkflowWriteHooks {
  beforeCommit?(tempPath: string, targetPath: string): Promise<void>
  expectedRevision?: string
}

const REVISION_RE = /^[0-9a-f]{64}$/

export function isWorkflowRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_RE.test(value)
}

export function workflowRevision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function serializedWorkflow(content: CwcFile): string {
  return JSON.stringify(content, null, 2)
}

function workflowIdentity(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('meta' in value)) return null
  const meta = value.meta
  if (typeof meta !== 'object' || meta === null || !('id' in meta)) return null
  return typeof meta.id === 'string' && meta.id.trim() ? meta.id : null
}

export async function readPersistedWorkflow(filePath: string, expectedId?: string): Promise<PersistedWorkflow> {
  const [raw, stat] = await Promise.all([
    fs.readFile(filePath, 'utf-8'),
    fs.lstat(filePath),
  ])
  if (!stat.isFile()) throw new WorkflowUpdateConflict('Stored workflow is not a regular file and cannot be updated safely.')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new WorkflowUpdateConflict('Stored workflow is invalid and cannot be updated safely.')
    throw error
  }
  const persistedId = workflowIdentity(parsed)
  if (!persistedId) throw new WorkflowUpdateConflict('Stored workflow has no valid recipe identity.')
  if (expectedId !== undefined && persistedId !== expectedId) {
    throw new WorkflowUpdateConflict('Workflow identity does not match the recipe stored at this path.')
  }
  return { content: parsed as CwcFile, mode: stat.mode, revision: workflowRevision(raw) }
}

export interface WorkflowMutationCoordinator {
  resolveWorkflowPath(filePath: string): string | null
  withPathLeases<T>(filePaths: string[], operation: () => Promise<T>): Promise<T>
}

/**
 * One process-wide coordinator must be shared by every recipe mutation route.
 * Export/delete hold the same path lease as autosave/rename so checking a
 * revision and committing deployment metadata is one serialized operation.
 */
export function createWorkflowMutationCoordinator(workflowsDir: string): WorkflowMutationCoordinator {
  const root = path.resolve(workflowsDir)
  const mutationQueues = new Map<string, Promise<void>>()

  function mutationKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath
  }

  return {
    resolveWorkflowPath(filePath) {
      if (!filePath.endsWith('.cwc')) return null
      const resolved = path.resolve(filePath)
      return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null
    },

    async withPathLeases<T>(filePaths: string[], operation: () => Promise<T>): Promise<T> {
      const keys = [...new Set(filePaths.map(mutationKey))].sort()
      const predecessors = keys.map(key => mutationQueues.get(key) ?? Promise.resolve())
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const tails = keys.map((key, index) => {
        const tail = predecessors[index].then(() => gate, () => gate)
        mutationQueues.set(key, tail)
        return tail
      })

      await Promise.all(predecessors.map(previous => previous.catch(() => undefined)))
      try {
        return await operation()
      } finally {
        release()
        keys.forEach((key, index) => {
          if (mutationQueues.get(key) === tails[index]) mutationQueues.delete(key)
        })
      }
    },
  }
}

async function writeTempWorkflow(filePath: string, content: CwcFile, mode: number): Promise<string> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${randomUUID()}.tmp`,
  )
  const handle = await fs.open(tempPath, 'wx', mode & 0o777)
  let complete = false
  try {
    await handle.writeFile(serializedWorkflow(content), 'utf-8')
    await handle.sync()
    complete = true
    return tempPath
  } finally {
    let closeError: unknown
    try {
      await handle.close()
    } catch (error) {
      closeError = error
    }
    if (!complete || closeError) await fs.unlink(tempPath).catch(() => {})
    if (closeError) throw closeError
  }
}

/** Writes a complete sibling temp file and atomically replaces an existing path. */
export async function replaceWorkflowFileAtomically(
  filePath: string,
  content: CwcFile,
  mode: number,
  hooks: AtomicWorkflowWriteHooks = {},
): Promise<void> {
  const tempPath = await writeTempWorkflow(filePath, content, mode)
  try {
    await hooks.beforeCommit?.(tempPath, filePath)
    if (hooks.expectedRevision) {
      const current = await readPersistedWorkflow(filePath)
      if (current.revision !== hooks.expectedRevision) {
        throw new WorkflowUpdateConflict('Workflow changed while CWC was preparing the save. Reload before saving again.')
      }
    }
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
  }
}

/** Publishes a complete sibling temp file without overwriting an existing path. */
async function publishWorkflowFileAtomically(filePath: string, content: CwcFile, mode: number): Promise<void> {
  const tempPath = await writeTempWorkflow(filePath, content, mode)
  try {
    // Linking is the portable no-clobber commit: the destination appears only
    // after the temp file is complete, and a racing create remains authoritative.
    await fs.link(tempPath, filePath)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
  }
}

export function workflowsRouter(
  workflowsDir: string,
  recentsPath: string,
  onSaved?: () => void | Promise<void>,
  acquireDeleteLease?: (workflowId: string) => Promise<WorkflowDeleteLease>,
  deleteUserExport?: WorkflowExportCleaner,
  mutationCoordinator: WorkflowMutationCoordinator = createWorkflowMutationCoordinator(workflowsDir),
) {
  const router = createRouter()
  const root = path.resolve(workflowsDir)
  const resolveWorkflowPath = mutationCoordinator.resolveWorkflowPath
  const withPathLeases = mutationCoordinator.withPathLeases

  function workflowListUpdated(metaUpdated: unknown, fileMtime: Date): string {
    const mtimeMs = fileMtime.getTime()
    const metaMs = typeof metaUpdated === 'string' ? Date.parse(metaUpdated) : Number.NaN
    const updatedMs = Number.isFinite(metaMs) ? Math.max(metaMs, mtimeMs) : mtimeMs
    return new Date(updatedMs).toISOString()
  }

  function workflowPath(name: unknown, sequence: number): string {
    const slug = slugify(typeof name === 'string' ? name : '') || 'untitled'
    const suffix = sequence === 1 ? '' : `-${sequence}`
    return path.join(root, `${slug}${suffix}.cwc`)
  }

  function isFsError(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
      && (err as NodeJS.ErrnoException).code === code
  }

  async function firstAvailableWorkflowPath(name: unknown): Promise<string> {
    for (let sequence = 1; ; sequence++) {
      const candidate = workflowPath(name, sequence)
      try {
        await fs.lstat(candidate)
      } catch (err) {
        if (isFsError(err, 'ENOENT')) return candidate
        throw err
      }
    }
  }

  async function createWorkflow(content: CwcFile): Promise<{ path: string; revision: string }> {
    await fs.mkdir(root, { recursive: true })
    const serialized = serializedWorkflow(content)
    for (let sequence = 1; ; sequence++) {
      const candidate = workflowPath(content?.meta?.name, sequence)
      try {
        await fs.writeFile(candidate, serialized, { encoding: 'utf-8', flag: 'wx' })
        return { path: candidate, revision: workflowRevision(serialized) }
      } catch (err) {
        if (isFsError(err, 'EEXIST')) continue
        throw err
      }
    }
  }

  // This route is an advisory preview. Creation still uses an exclusive write because
  // another request can claim the returned path before a client acts on it.
  router.get('/default-path', async (req, res) => {
    try {
      res.json({ path: await firstAvailableWorkflowPath(req.query['name']) })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.get('/list', async (_req, res) => {
    try {
      await fs.mkdir(workflowsDir, { recursive: true })
      const entries = await fs.readdir(workflowsDir)
      const items = await Promise.all(
        entries
          .filter((f) => f.endsWith('.cwc'))
          .map(async (f) => {
            const fullPath = path.join(workflowsDir, f)
            try {
              const stat = await fs.stat(fullPath)
              const raw = await fs.readFile(fullPath, 'utf-8')
              const cwc: CwcFile = JSON.parse(raw)
              return {
                id: cwc.meta.id,
                path: fullPath,
                name: cwc.meta.name,
                updated: workflowListUpdated(cwc.meta.updated, stat.mtime),
                nodeCount: cwc.nodes.length,
                artifactKind: artifactKindOf(cwc),
                artifactTier: artifactTierOf(cwc),
              }
            } catch {
              return null
            }
          })
      )
      res.json(items.filter(Boolean))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.get('/', async (req, res) => {
    const filePath = req.query['path'] as string
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    const resolved = resolveWorkflowPath(filePath)
    if (!resolved) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    try {
      const raw = await fs.readFile(resolved, 'utf-8')
      res.setHeader('X-CWC-Revision', workflowRevision(raw))
      res.json(JSON.parse(raw))
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })

  router.post('/create', async (req, res) => {
    const { content } = (req.body ?? {}) as { content?: CwcFile }
    if (!content) return void res.status(400).json({ error: 'content required' })
    try {
      const created = await createWorkflow(content)
      await onSaved?.()
      res.status(201).json({ saved: true, ...created })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/', async (req, res) => {
    const { path: filePath, content, expectedRevision } = req.body as {
      path: string
      content: CwcFile
      expectedRevision?: string
    }
    if (!filePath || !content) return void res.status(400).json({ error: 'path and content required' })
    if (typeof content.meta?.id !== 'string' || !content.meta.id.trim()) {
      return void res.status(400).json({ error: 'content.meta.id required' })
    }
    const resolved = resolveWorkflowPath(filePath)
    if (!resolved) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    if (!isWorkflowRevision(expectedRevision)) {
      return void res.status(409).json({ error: 'Workflow revision required. Reload this recipe before saving.' })
    }
    try {
      let revision = ''
      await withPathLeases([resolved], async () => {
        const persisted = await readPersistedWorkflow(resolved, content.meta.id)
        if (persisted.revision !== expectedRevision) {
          throw new WorkflowUpdateConflict('Workflow changed in another editor. Reload before saving again.')
        }
        await replaceWorkflowFileAtomically(resolved, content, persisted.mode, {
          expectedRevision: persisted.revision,
        })
        revision = workflowRevision(serializedWorkflow(content))
        await onSaved?.()
      })
      res.json({ saved: true, revision })
    } catch (err) {
      if (isFsError(err, 'ENOENT')) {
        return void res.status(404).json({ error: 'Workflow no longer exists. Create a new recipe instead of saving this stale editor.' })
      }
      if (err instanceof WorkflowUpdateConflict) return void res.status(409).json({ error: err.message })
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    const resolved = resolveWorkflowPath(filePath)
    if (!resolved) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    const cleanupUserExport = req.query['cleanupUserExport'] === '1'
    const suppliedExpectedId = typeof req.query['workflowId'] === 'string' ? req.query['workflowId'] : undefined
    if (suppliedExpectedId !== undefined && !suppliedExpectedId.trim()) {
      return void res.status(400).json({ error: 'workflowId must not be empty' })
    }
    try {
      // Older clients did not send workflowId. Capture their observed identity,
      // then still re-read and validate it after acquiring the mutation lease.
      const expectedId = suppliedExpectedId ?? (await readPersistedWorkflow(resolved)).content.meta.id
      const blockedReason = await withPathLeases([resolved], async () => {
        const { content: workflow } = await readPersistedWorkflow(resolved, expectedId)
        const lease = acquireDeleteLease ? await acquireDeleteLease(workflow.meta.id) : undefined
        try {
          if (lease?.reason) return lease.reason
          // Keep the recipe as recovery authority unless its known user-scoped deployment
          // was cleaned successfully. This runs while both the recipe mutation lease and
          // managed-run delete lease are held.
          if (cleanupUserExport) {
            if (!deleteUserExport) throw new Error('User export cleanup is unavailable.')
            await deleteUserExport(workflow)
          }
          await fs.unlink(resolved)
          await onSaved?.()
          return null
        } finally {
          lease?.release()
        }
      })
      if (blockedReason) return void res.status(409).json({ error: blockedReason })
      res.json({ deleted: true })
    } catch (err) {
      if (isFsError(err, 'ENOENT')) return void res.status(404).json({ error: 'not found' })
      if (err instanceof WorkflowUpdateConflict) return void res.status(409).json({ error: err.message })
      res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' })
    }
  })

  router.post('/rename', async (req, res) => {
    const { oldPath, newName, workflowId, expectedRevision } = req.body as {
      oldPath: string
      newName: string
      workflowId?: string
      expectedRevision?: string
    }
    if (!oldPath || !newName) return void res.status(400).json({ error: 'oldPath and newName required' })
    if (!isWorkflowRevision(expectedRevision)) {
      return void res.status(409).json({ error: 'Workflow revision required. Reload this recipe before renaming.' })
    }
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !workflowId.trim())) {
      return void res.status(400).json({ error: 'workflowId must not be empty' })
    }
    const resolvedOldPath = resolveWorkflowPath(oldPath)
    if (!resolvedOldPath) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    const newSlug = slugify(newName) || 'untitled'
    const dir = path.dirname(resolvedOldPath)
    const newPath = path.join(dir, `${newSlug}.cwc`)

    try {
      // Preserve the legacy request shape without letting it operate on a file
      // whose identity changed while the request waited for its path leases.
      const expectedId = workflowId ?? (await readPersistedWorkflow(resolvedOldPath)).content.meta.id
      const result = await withPathLeases([resolvedOldPath, newPath], async () => {
        const persisted = await readPersistedWorkflow(resolvedOldPath, expectedId)
        if (persisted.revision !== expectedRevision) {
          throw new WorkflowUpdateConflict('Workflow changed in another editor. Reload before renaming again.')
        }
        const renamedNodes = persisted.content.nodes.map(node => (
          artifactKindOf(persisted.content) === 'skill'
            && persisted.content.nodes.length === 1
            && node.nodeType !== 'gate'
            && !node.agentRef
            ? { ...node, agent: { ...node.agent, name: newName } }
            : node
        ))
        const contentChanged = persisted.content.meta.name !== newName
          || renamedNodes.some((node, index) => node.agent.name !== persisted.content.nodes[index]?.agent.name)
        const cwc: CwcFile = contentChanged
          ? {
              ...persisted.content,
              meta: { ...persisted.content.meta, name: newName, updated: new Date().toISOString() },
              nodes: renamedNodes,
            }
          : persisted.content
        const persistedName = persisted.content.meta.name

        if (newPath === resolvedOldPath) {
          await replaceWorkflowFileAtomically(resolvedOldPath, cwc, persisted.mode, {
            expectedRevision: persisted.revision,
          })
          await onSaved?.()
          return {
            path: resolvedOldPath,
            renamed: false,
            revision: workflowRevision(serializedWorkflow(cwc)),
            content: cwc,
          }
        }
        if (persistedName === newName) {
          try {
            await fs.lstat(newPath)
            // A suffix is part of this recipe's storage identity when another file
            // already owns the canonical name. A blur with no display-name change
            // must not turn that harmless duplicate into a collision error.
            return { path: resolvedOldPath, renamed: false, revision: persisted.revision, content: persisted.content }
          } catch (err) {
            if (!isFsError(err, 'ENOENT')) throw err
            // Autosave may already have persisted the new display name at the old
            // path. With no destination collision, still finish the filename move.
          }
        }

        await publishWorkflowFileAtomically(newPath, cwc, persisted.mode)
        try {
          const currentSource = await readPersistedWorkflow(resolvedOldPath, expectedId)
          if (currentSource.revision !== persisted.revision) {
            throw new WorkflowUpdateConflict('Workflow changed while CWC was preparing the rename. Reload before trying again.')
          }
          await fs.unlink(resolvedOldPath)
        } catch (error) {
          // Publication is rolled back if the source cannot be retired, so a
          // failed rename never leaves a second live recipe behind.
          await fs.unlink(newPath).catch(() => {})
          throw error
        }
        await onSaved?.()

        try {
          const recentsRaw = await fs.readFile(recentsPath, 'utf-8')
          const recents: string[] = JSON.parse(recentsRaw)
          const updated = recents.map((p) => (p === oldPath || p === resolvedOldPath ? newPath : p))
          await fs.writeFile(recentsPath, JSON.stringify(updated, null, 2), 'utf-8')
        } catch { /* recents file missing or corrupt — skip */ }

        return {
          path: newPath,
          renamed: true,
          revision: workflowRevision(serializedWorkflow(cwc)),
          content: cwc,
        }
      })
      res.json(result)
    } catch (err) {
      if (isFsError(err, 'EEXIST')) return void res.status(400).json({ error: 'A workflow with that name already exists' })
      if (isFsError(err, 'ENOENT')) return void res.status(404).json({ error: 'not found' })
      if (err instanceof WorkflowUpdateConflict) return void res.status(409).json({ error: err.message })
      res.status(500).json({ error: err instanceof Error ? err.message : 'rename failed' })
    }
  })

  return router
}
