import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const MAX_RECENTS = 10

export function recentsRouter(recentsPath: string) {
  const router = createRouter()

  async function readRecents(): Promise<string[]> {
    try {
      const raw = await fs.readFile(recentsPath, 'utf-8')
      return JSON.parse(raw) as string[]
    } catch { return [] }
  }

  router.get('/', async (_req, res) => {
    res.json(await readRecents())
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    const existing = await readRecents()
    const updated = existing.filter((p) => p !== filePath)
    await fs.mkdir(path.dirname(recentsPath), { recursive: true })
    await fs.writeFile(recentsPath, JSON.stringify(updated, null, 2), 'utf-8')
    res.json(updated)
  })

  router.post('/', async (req, res) => {
    const { path: filePath } = req.body as { path: string }
    if (!filePath) return void res.status(400).json({ error: 'path required' })
    const existing = await readRecents()
    const updated = [filePath, ...existing.filter((p) => p !== filePath)].slice(0, MAX_RECENTS)
    await fs.mkdir(path.dirname(recentsPath), { recursive: true })
    await fs.writeFile(recentsPath, JSON.stringify(updated, null, 2), 'utf-8')
    res.json(updated)
  })

  return router
}
