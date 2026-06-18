import { Router as createRouter } from 'express'
import * as path from 'node:path'
import * as os from 'node:os'
import open from 'open'

export function openFileRouter() {
  const router = createRouter()

  router.post('/', (req, res) => {
    const { path: filePath } = req.body as { path?: string }
    if (!filePath) {
      res.status(400).json({ error: 'path body field required' })
      return
    }

    // Restrict to .claude directory.
    // Use claudeDir + path.sep to avoid matching ~/.claudeevil/ etc.
    const claudeDir = path.join(os.homedir(), '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }

    open(resolved).then(() => {
      res.json({ opened: true })
    }).catch(() => {
      res.status(500).json({ error: 'Failed to open file' })
    })
  })

  return router
}
