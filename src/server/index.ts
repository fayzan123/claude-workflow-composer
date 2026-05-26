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
import { skillsRouter } from './api/skills.js'

export interface AppOptions {
  staticDir: string | null
  workflowsDir?: string
  userHomeDir?: string
  recentsPath?: string
}

export function createApp(opts: AppOptions): express.Express {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  app.use('/api/health', healthRouter())
  app.use('/api/claude-check', claudeCheckRouter())

  const wfDir = opts.workflowsDir ?? path.join(os.homedir(), '.cwc', 'workflows')
  app.use('/api/workflows', workflowsRouter(wfDir))

  const homeDir = opts.userHomeDir ?? os.homedir()
  app.use('/api/agents', agentsRouter(homeDir))

  const recPath = opts.recentsPath ?? path.join(os.homedir(), '.cwc', 'recents.json')
  app.use('/api/recents', recentsRouter(recPath))

  app.use('/api/export/preview', exportPreviewRouter())
  app.use('/api/export', exportRouter())
  app.use('/api/skills', skillsRouter(homeDir))

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
