import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

export function fileContentRouter() {
  const router = createRouter()

  router.get('/', async (req, res) => {
    const filePath = req.query['path'] as string | undefined
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' })
      return
    }

    // Restrict to .claude directory to prevent arbitrary file reads.
    // Use claudeDir + path.sep to avoid matching ~/.claudeevil/ etc.
    const homeDir = os.homedir()
    const claudeDir = path.join(homeDir, '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }

    try {
      const content = await fs.readFile(resolved, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'File not found' })
    }
  })

  return router
}
