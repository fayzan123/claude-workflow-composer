import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CwcFile } from '../../schema.js'
import { slugify } from '../../slugify.js'

export interface WorkflowDeleteLease {
  reason: string | null
  release(): void
}

export function workflowsRouter(
  workflowsDir: string,
  recentsPath: string,
  onSaved?: () => void,
  acquireDeleteLease?: (workflowId: string) => Promise<WorkflowDeleteLease>,
) {
  const router = createRouter()
  const root = path.resolve(workflowsDir)

  function workflowListUpdated(metaUpdated: unknown, fileMtime: Date): string {
    const mtimeMs = fileMtime.getTime()
    const metaMs = typeof metaUpdated === 'string' ? Date.parse(metaUpdated) : Number.NaN
    const updatedMs = Number.isFinite(metaMs) ? Math.max(metaMs, mtimeMs) : mtimeMs
    return new Date(updatedMs).toISOString()
  }

  function resolveWorkflowPath(filePath: string): string | null {
    if (!filePath.endsWith('.cwc')) return null
    const resolved = path.resolve(filePath)
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null
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

  async function createWorkflow(content: CwcFile): Promise<string> {
    await fs.mkdir(root, { recursive: true })
    const serialized = JSON.stringify(content, null, 2)
    for (let sequence = 1; ; sequence++) {
      const candidate = workflowPath(content?.meta?.name, sequence)
      try {
        await fs.writeFile(candidate, serialized, { encoding: 'utf-8', flag: 'wx' })
        return candidate
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
      res.json(JSON.parse(raw))
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })

  router.post('/create', async (req, res) => {
    const { content } = (req.body ?? {}) as { content?: CwcFile }
    if (!content) return void res.status(400).json({ error: 'content required' })
    try {
      const filePath = await createWorkflow(content)
      onSaved?.()
      res.status(201).json({ saved: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/', async (req, res) => {
    const { path: filePath, content } = req.body as { path: string; content: CwcFile }
    if (!filePath || !content) return void res.status(400).json({ error: 'path and content required' })
    const resolved = resolveWorkflowPath(filePath)
    if (!resolved) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, JSON.stringify(content, null, 2), 'utf-8')
      onSaved?.()
      res.json({ saved: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    const resolved = resolveWorkflowPath(filePath)
    if (!resolved) return void res.status(403).json({ error: 'Access restricted to workflows directory' })
    let releaseDeleteLease: (() => void) | undefined
    try {
      if (acquireDeleteLease) {
        const raw = await fs.readFile(resolved, 'utf-8')
        const workflow = JSON.parse(raw) as CwcFile
        const lease = await acquireDeleteLease(workflow.meta.id)
        releaseDeleteLease = lease.release
        if (lease.reason) return void res.status(409).json({ error: lease.reason })
      }
      await fs.unlink(resolved)
      onSaved?.()
      res.json({ deleted: true })
    } catch (err) {
      if (isFsError(err, 'ENOENT')) return void res.status(404).json({ error: 'not found' })
      if (err instanceof SyntaxError) return void res.status(409).json({ error: 'Workflow file is invalid and could not be checked for active runs.' })
      res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' })
    } finally {
      releaseDeleteLease?.()
    }
  })

  router.post('/rename', async (req, res) => {
    const { oldPath, newName } = req.body as { oldPath: string; newName: string }
    if (!oldPath || !newName) return void res.status(400).json({ error: 'oldPath and newName required' })
    const resolvedOldPath = resolveWorkflowPath(oldPath)
    if (!resolvedOldPath) return void res.status(403).json({ error: 'Access restricted to workflows directory' })

    let raw: string
    try {
      raw = await fs.readFile(resolvedOldPath, 'utf-8')
    } catch {
      return void res.status(404).json({ error: 'not found' })
    }

    const cwc: CwcFile = JSON.parse(raw)
    if (cwc.meta.name === newName) return void res.json({ path: resolvedOldPath, renamed: false })

    const newSlug = slugify(newName) || 'untitled'
    const dir = path.dirname(resolvedOldPath)
    const newPath = path.join(dir, `${newSlug}.cwc`)

    if (newPath === resolvedOldPath) return void res.json({ path: resolvedOldPath, renamed: false })

    cwc.meta.name = newName
    cwc.meta.updated = new Date().toISOString()
    try {
      await fs.writeFile(newPath, JSON.stringify(cwc, null, 2), { encoding: 'utf-8', flag: 'wx' })
    } catch (err) {
      if (isFsError(err, 'EEXIST')) return void res.status(400).json({ error: 'A workflow with that name already exists' })
      throw err
    }
    await fs.unlink(resolvedOldPath)
    onSaved?.()

    try {
      const recentsRaw = await fs.readFile(recentsPath, 'utf-8')
      const recents: string[] = JSON.parse(recentsRaw)
      const updated = recents.map((p) => (p === oldPath || p === resolvedOldPath ? newPath : p))
      await fs.writeFile(recentsPath, JSON.stringify(updated, null, 2), 'utf-8')
    } catch { /* recents file missing or corrupt — skip */ }

    res.json({ path: newPath, renamed: true })
  })

  return router
}
