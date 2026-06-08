import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export function fileContentRouter(userHomeDir: string) {
  const router = createRouter()
  const claudeDir = path.join(userHomeDir, '.claude')

  // Resolve and confirm a path stays inside ~/.claude. Returns the resolved path,
  // or null if it escapes (use claudeDir + sep to avoid matching ~/.claudeevil/).
  function safeResolve(filePath: string): string | null {
    const resolved = path.resolve(filePath)
    return resolved.startsWith(claudeDir + path.sep) ? resolved : null
  }

  router.get('/', async (req, res) => {
    const filePath = req.query['path'] as string | undefined
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' })
      return
    }
    const resolved = safeResolve(filePath)
    if (!resolved) {
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

  // Write-back (edit). Requires the file to already exist — this is edit, not create.
  router.post('/', async (req, res) => {
    const filePath = req.body?.path
    const content = req.body?.content
    if (typeof filePath !== 'string' || typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ error: 'path and content are required' })
      return
    }
    const resolved = safeResolve(filePath)
    if (!resolved) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }
    try {
      await fs.access(resolved)
    } catch {
      res.status(404).json({ error: 'File not found' })
      return
    }
    try {
      await fs.writeFile(resolved, content, 'utf-8')
      res.json({ saved: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
