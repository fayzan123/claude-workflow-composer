import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { CwcFile } from '../../schema.js'
import { slugify } from '../../slugify.js'

export function workflowsRouter(workflowsDir: string, recentsPath: string, onSaved?: () => void) {
  const router = createRouter()
  const root = path.resolve(workflowsDir)

  function resolveWorkflowPath(filePath: string): string | null {
    if (!filePath.endsWith('.cwc')) return null
    const resolved = path.resolve(filePath)
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null
  }

  router.get('/default-path', (req, res) => {
    const name = (req.query['name'] as string) || 'untitled'
    const slug = slugify(name) || 'untitled'
    res.json({ path: path.join(workflowsDir || path.join(os.homedir(), '.cwc', 'workflows'), `${slug}.cwc`) })
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
              const raw = await fs.readFile(fullPath, 'utf-8')
              const cwc: CwcFile = JSON.parse(raw)
              return { id: cwc.meta.id, path: fullPath, name: cwc.meta.name, updated: cwc.meta.updated, nodeCount: cwc.nodes.length }
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
    try {
      await fs.unlink(resolved)
      res.json({ deleted: true })
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })

  router.post('/rename', async (req, res) => {
    const { oldPath, newName } = req.body as { oldPath: string; newName: string }
    if (!oldPath || !newName) return void res.status(400).json({ error: 'oldPath and newName required' })
    const resolvedOldPath = resolveWorkflowPath(oldPath)
    if (!resolvedOldPath) return void res.status(403).json({ error: 'Access restricted to workflows directory' })

    const newSlug = slugify(newName) || 'untitled'
    const dir = path.dirname(resolvedOldPath)
    const newPath = path.join(dir, `${newSlug}.cwc`)

    if (newPath === resolvedOldPath) return void res.json({ path: resolvedOldPath, renamed: false })
    if (await fs.access(newPath).then(() => true).catch(() => false)) {
      return void res.status(400).json({ error: 'A workflow with that name already exists' })
    }

    let raw: string
    try {
      raw = await fs.readFile(resolvedOldPath, 'utf-8')
    } catch {
      return void res.status(404).json({ error: 'not found' })
    }

    const cwc: CwcFile = JSON.parse(raw)
    cwc.meta.name = newName
    cwc.meta.updated = new Date().toISOString()
    await fs.writeFile(newPath, JSON.stringify(cwc, null, 2), 'utf-8')
    await fs.unlink(resolvedOldPath)

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
