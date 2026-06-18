import { Router as createRouter } from 'express'
import type { Router } from 'express'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as fs from 'node:fs'

/**
 * Source the version from package.json so /api/health never drifts from the real release.
 * Walks up from this module to the nearest claude-cwc package.json — robust whether running
 * from src (tests) or dist (packaged), and when installed under node_modules.
 */
function readVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === 'claude-cwc' && pkg.version) return pkg.version
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* fall through to fallback */ }
  return '0.0.0'
}

const VERSION = readVersion()

export function healthRouter(): Router {
  const router = createRouter()
  router.get('/', (_req, res) => {
    res.json({ status: 'ok', version: VERSION })
  })
  return router
}
