import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { CwcFile } from '../../schema.js'
import { slugify } from '../../slugify.js'

export function workflowsRouter(workflowsDir: string, recentsPath: string) {
  const router = createRouter()

  router.get('/default-path', (req, res) => {
    const name = (req.query['name'] as string) || 'untitled'
    const slug = slugify(name) || 'untitled'
    res.json({ path: path.join(os.homedir(), '.cwc', 'workflows', `${slug}.cwc`) })
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
              return { path: fullPath, name: cwc.meta.name, updated: cwc.meta.updated, nodeCount: cwc.nodes.length }
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
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      res.json(JSON.parse(raw))
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })

  router.post('/', async (req, res) => {
    const { path: filePath, content } = req.body as { path: string; content: CwcFile }
    if (!filePath || !content) return void res.status(400).json({ error: 'path and content required' })
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8')
      res.json({ saved: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    try {
      await fs.unlink(filePath)
      res.json({ deleted: true })
    } catch {
      res.status(404).json({ error: 'not found' })
    }
  })

  return router
}
