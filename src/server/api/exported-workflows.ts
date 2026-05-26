import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'

const WORKFLOW_ID_REGEX = /<!-- cwc:workflow:([^:\s>]+) -->/

export interface ExportedWorkflowEntry {
  slug: string
  name: string
  description: string
  skillDir: string
}

export function exportedWorkflowsRouter(homeDir: string) {
  const router = createRouter()
  const skillsDir = path.join(homeDir, '.claude', 'skills')

  router.get('/', async (_req, res) => {
    const results: ExportedWorkflowEntry[] = []
    try {
      const dirs = await fs.readdir(skillsDir)
      for (const slug of dirs) {
        const skillFile = path.join(skillsDir, slug, 'SKILL.md')
        try {
          const raw = await fs.readFile(skillFile, 'utf-8')
          if (!WORKFLOW_ID_REGEX.test(raw)) continue
          const { data } = matter(raw)
          results.push({
            slug,
            name: String(data['name'] ?? slug),
            description: String(data['description'] ?? ''),
            skillDir: path.join(skillsDir, slug),
          })
        } catch { /* skip */ }
      }
    } catch { /* skills dir missing */ }
    res.json(results)
  })

  router.delete('/', async (req, res) => {
    const slug = req.query['slug'] as string
    if (!slug) return void res.status(400).json({ error: 'slug required' })

    const skillDir = path.join(skillsDir, slug)
    try {
      await fs.access(skillDir)
    } catch {
      return void res.status(404).json({ error: 'not found' })
    }

    try {
      await fs.rm(skillDir, { recursive: true, force: true })
      res.json({ deleted: skillDir })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
