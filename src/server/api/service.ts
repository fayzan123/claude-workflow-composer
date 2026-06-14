// src/server/api/service.ts
import { Router } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SERVICE_LABEL } from '../service-plist.js'

export function serviceRouter(homeDir: string): Router {
  const router = Router()
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
  router.get('/', (_req, res) => {
    res.json({ persistent: fs.existsSync(plistPath), platform: process.platform })
  })
  return router
}
