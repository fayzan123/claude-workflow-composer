import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

export function createServerToken(): string {
  return randomUUID()
}

/**
 * Resolve the API auth token for the packaged server. Returns a fresh token normally,
 * or `undefined` when `CWC_DISABLE_AUTH=1` — the local-dev escape hatch so the Vite
 * dev server (which serves the HTML itself and so never receives the UI cookie) can
 * talk to the API. Only honor this for loopback binds; the packaged app stays authed.
 */
export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env['CWC_DISABLE_AUTH'] === '1') return undefined
  return createServerToken()
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function installUiTokenCookie(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.cookie('cwc_token', token, {
        httpOnly: false,
        sameSite: 'strict',
        path: '/',
      })
    }
    next()
  }
}

export function requireApiToken(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next()
    if (req.method === 'GET' && req.path === '/api/health') return next()
    if (req.method === 'POST' && req.path.startsWith('/api/triggers/')) return next()
    if (req.method === 'POST' && req.path === '/api/runs/events') return next()

    const header = req.header('x-cwc-token')
    const auth = req.header('authorization')
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
    const cookie = cookieValue(req, 'cwc_token')
    if (header === token || bearer === token || cookie === token) return next()

    res.status(401).json({ error: 'CWC API token required' })
  }
}

export function restrictCors(allowedOrigins: string[] = []) {
  const allowed = new Set(allowedOrigins)
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin')
    if (!origin) {
      if (req.method === 'OPTIONS') return void res.sendStatus(204)
      return next()
    }
    if (!allowed.has(origin)) {
      if (req.method === 'OPTIONS') return void res.sendStatus(403)
      return next()
    }
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-CWC-Token, Authorization')
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') return void res.sendStatus(204)
    next()
  }
}
