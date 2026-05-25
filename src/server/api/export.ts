import { Router as createRouter } from 'express'
import { exportWorkflow } from '../../exporter.js'
import type { ExportTarget, ExportOptions } from '../../exporter.js'
import type { CwcFile } from '../../schema.js'
import * as os from 'node:os'
import * as path from 'node:path'

export function exportRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target, skillsDir } = req.body as {
      cwcFile: CwcFile
      target: ExportTarget
      skillsDir?: string
    }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })

    const opts: ExportOptions = {
      skillsDir: skillsDir ?? path.join(os.homedir(), '.claude', 'skills'),
    }

    try {
      const result = await exportWorkflow(cwcFile, target, opts)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
