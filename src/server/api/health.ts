import { Router as createRouter } from 'express'
import type { Router } from 'express'

export function healthRouter(): Router {
  const router = createRouter()
  router.get('/', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' })
  })
  return router
}
