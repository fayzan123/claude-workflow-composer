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

function parseOrigin(origin: string): URL | null {
  try {
    return new URL(origin)
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/**
 * @param allowLoopback when true, any loopback Origin (localhost/127.0.0.1) is accepted even
 * if its Host differs — needed for the Vite dev server, which forwards Origin :5173 but rewrites
 * Host to :3579. Only enabled in dev (auth off); a remote page can't forge a loopback Origin, so
 * this does not reopen the CSRF hole. Packaged mode keeps it false (strict same-origin only).
 */
export function restrictCors(allowedOrigins: string[] = [], opts: { allowLoopback?: boolean } = {}) {
  const allowed = new Set(allowedOrigins)
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin')

    // No Origin header: a same-origin navigation or a non-browser client (curl, the
    // spawned claude run-logger posting to /api/runs/events). Nothing cross-origin to gate.
    if (!origin) {
      if (req.method === 'OPTIONS') return void res.sendStatus(204)
      return next()
    }

    const url = parseOrigin(origin)
    const sameOrigin = !!url && url.host === req.headers.host
    const loopbackOk = !!opts.allowLoopback && !!url && isLoopbackHostname(url.hostname)

    // Disallowed cross-origin: reject outright so the handler never runs. Withholding CORS
    // headers alone would still execute the request server-side — that lets a malicious page
    // drive-by the token-exempt mutating endpoints (e.g. POST /api/runs/events) via CSRF.
    if (!sameOrigin && !loopbackOk && !allowed.has(origin)) {
      return void res.status(403).json({ error: 'cross-origin request not allowed' })
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
