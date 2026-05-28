import { Router as createRouter } from 'express'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'

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

    // Use platform-appropriate open command. execFile (not exec) so the path is
    // passed as a literal argv entry — no shell, no interpolation of quotes/
    // backticks in a filename that happens to live under .claude.
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(opener, [resolved], (err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to open file' })
        return
      }
      res.json({ opened: true })
    })
  })

  return router
}
