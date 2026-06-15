// src/server/api/automation-candidates.ts
import { Router } from 'express'
import { findTranscripts, parseSession } from '../../detection/transcript-parser.js'
import { detectCandidates } from '../../detection/detector.js'
import type { TaskUnit } from '../../detection/types.js'

export function automationCandidatesRouter(homeDir: string): Router {
  const router = Router()
  router.get('/', async (_req, res) => {
    try {
      const files = await findTranscripts(homeDir)
      const units: TaskUnit[] = []
      for (const f of files) units.push(...await parseSession(f))
      res.json(detectCandidates(units))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'detection failed' })
    }
  })
  return router
}
