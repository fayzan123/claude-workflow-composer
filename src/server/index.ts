import express from 'express'
import cors from 'cors'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { healthRouter } from './api/health.js'
import { claudeCheckRouter } from './api/claude-check.js'
import { workflowsRouter } from './api/workflows.js'
import { agentsRouter } from './api/agents.js'
import { recentsRouter } from './api/recents.js'
import { exportRouter } from './api/export.js'
import { exportPreviewRouter } from './api/export-preview.js'
import { exportDeleteRouter } from './api/export-delete.js'
import { skillsRouter } from './api/skills.js'
import { fileContentRouter } from './api/file-content.js'
import { openFileRouter } from './api/open-file.js'
import { exportedWorkflowsRouter } from './api/exported-workflows.js'
import type { ClaudeRunner } from './claude-runner.js'
import { agentsGenerateRouter } from './api/agents-generate.js'

export interface AppOptions {
  staticDir: string | null
  workflowsDir?: string
  userHomeDir?: string
  recentsPath?: string
  claudeRunner?: ClaudeRunner
}

export function createApp(opts: AppOptions): express.Express {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  app.use('/api/health', healthRouter())
  app.use('/api/claude-check', claudeCheckRouter())

  const wfDir = opts.workflowsDir ?? path.join(os.homedir(), '.cwc', 'workflows')
  const recPath = opts.recentsPath ?? path.join(os.homedir(), '.cwc', 'recents.json')
  app.use('/api/workflows', workflowsRouter(wfDir, recPath))

  const homeDir = opts.userHomeDir ?? os.homedir()
  app.use('/api/agents/generate', agentsGenerateRouter(opts.claudeRunner))
  app.use('/api/agents', agentsRouter(homeDir))

  app.use('/api/recents', recentsRouter(recPath))

  app.use('/api/export/preview', exportPreviewRouter())
  app.use('/api/export/delete', exportDeleteRouter())
  app.use('/api/export', exportRouter())
  app.use('/api/skills', skillsRouter(homeDir))
  app.use('/api/file-content', fileContentRouter())
  app.use('/api/open-file', openFileRouter())
  app.use('/api/exported-workflows', exportedWorkflowsRouter(homeDir))

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir))
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(opts.staticDir!, 'index.html'))
    })
  }

  return app
}

export function startServer(port: number, staticDir: string | null): Promise<void> {
  const app = createApp({ staticDir })
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`CWC server running on http://localhost:${port}`)
      resolve()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Run 'cwc stop' to kill the existing server.`)
      }
      reject(err)
    })
  })
}
