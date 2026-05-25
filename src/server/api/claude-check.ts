import { Router as createRouter } from 'express'
import type { Router } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

export function claudeCheckRouter(): Router {
  const router = createRouter()
  router.get('/', async (_req, res) => {
    const claudeDir = path.join(os.homedir(), '.claude')
    try {
      await fs.access(claudeDir)
      res.json({ installed: true, claudeDir })
    } catch {
      res.json({ installed: false, claudeDir })
    }
  })
  return router
}
