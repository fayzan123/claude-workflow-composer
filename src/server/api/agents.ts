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

  return router
}
