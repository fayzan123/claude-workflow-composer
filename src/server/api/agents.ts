import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'

export interface AgentEntry {
  name: string
  description: string
  slug: string
  source: 'user' | 'project'
  filePath: string
}

async function scanAgentsDir(dir: string, source: 'user' | 'project'): Promise<AgentEntry[]> {
  try {
    const files = await fs.readdir(dir)
    const results = await Promise.all(
      files
        .filter((f) => f.endsWith('.md'))
        .map(async (f) => {
          const fullPath = path.join(dir, f)
          try {
            const raw = await fs.readFile(fullPath, 'utf-8')
            const { data } = matter(raw)
            if (!data['name']) return null
            return {
              name: String(data['name']),
              description: String(data['description'] ?? ''),
              slug: f.replace(/\.md$/, ''),
              source,
              filePath: fullPath,
            }
          } catch { return null }
        })
    )
    return results.filter((r): r is AgentEntry => r !== null)
  } catch {
    return []
  }
}

export function agentsRouter(userHomeDir: string) {
  const router = createRouter()

  router.get('/', async (req, res) => {
    const projectDir = req.query['projectDir'] as string | undefined
    const userAgentsDir = path.join(userHomeDir, '.claude', 'agents')
    const agents: AgentEntry[] = [
      ...await scanAgentsDir(userAgentsDir, 'user'),
      ...(projectDir ? await scanAgentsDir(path.join(projectDir, '.claude', 'agents'), 'project') : []),
    ]
    res.json(agents)
  })

  router.post('/', async (req, res) => {
    const slug = req.body?.slug
    const content = req.body?.content
    const overwrite = req.body?.overwrite === true
    if (typeof slug !== 'string' || typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ error: 'slug and content are required' })
      return
    }
    // Reject anything that isn't a plain slug (no separators, no traversal).
    // The regex also rejects an empty or whitespace-only slug.
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'invalid slug' })
      return
    }
    const dir = path.join(userHomeDir, '.claude', 'agents')
    const filePath = path.join(dir, `${slug}.md`)
    try {
      await fs.mkdir(dir, { recursive: true })
      if (!overwrite) {
        // No O_EXCL here — ~/.claude/agents/ is a single-user dir, so the race is benign.
        try {
          await fs.access(filePath)
          res.status(409).json({ error: `An agent named "${slug}" already exists.` })
          return
        } catch { /* does not exist — proceed */ }
      }
      await fs.writeFile(filePath, content, 'utf-8')
      res.json({ slug, filePath })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string | undefined
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' })
      return
    }
    const claudeDir = path.join(userHomeDir, '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }
    if (!resolved.endsWith('.md') || !resolved.split(path.sep).includes('agents')) {
      res.status(400).json({ error: 'not an agent file' })
      return
    }
    try {
      await fs.unlink(resolved)
      res.json({ deleted: true })
    } catch {
      res.status(404).json({ error: 'File not found' })
    }
  })

  return router
}
