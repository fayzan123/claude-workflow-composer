import { Router as createRouter } from 'express'
import { ExportConflictError, exportWorkflow } from '../../export/exporter.js'
import type { ExportTarget, ExportOptions } from '../../export/exporter.js'
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
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) {
      return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    }
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) {
      return void res.status(400).json({ error: 'userDir must be an absolute path' })
    }
    if (skillsDir && !path.isAbsolute(skillsDir)) {
      return void res.status(400).json({ error: 'skillsDir must be an absolute path' })
    }

    const opts: ExportOptions = {
      skillsDir: skillsDir ?? path.join(os.homedir(), '.claude', 'skills'),
    }

    try {
      const result = await exportWorkflow(cwcFile, target, opts)
      res.json(result)
    } catch (err) {
      if (err instanceof ExportConflictError) {
        return void res.status(409).json({ error: err.message, path: err.filePath })
      }
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
