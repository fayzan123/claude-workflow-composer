import { describe, it, expect } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { resolveAuthToken, restrictCors } from '../../src/server/security.js'

/** Minimal fake req/res to drive the CORS middleware without a live server. */
function run(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  opts: { origin?: string; host?: string; method?: string },
) {
  const headers: Record<string, string> = {}
  if (opts.origin) headers['origin'] = opts.origin
  const req = {
    method: opts.method ?? 'GET',
    headers: { host: opts.host ?? 'localhost:3579' },
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request
  let nexted = false
  let statusCode: number | null = null
  let cors: string | undefined
  const res = {
    header: (k: string, v: string) => { if (k === 'Access-Control-Allow-Origin') cors = v },
    status: (c: number) => { statusCode = c; return res },
    json: () => res,
    sendStatus: (c: number) => { statusCode = c; return res },
  } as unknown as Response
  mw(req, res, () => { nexted = true })
  return { nexted, statusCode, cors }
}

describe('resolveAuthToken', () => {
  it('returns a token by default (auth on)', () => {
    expect(resolveAuthToken({})).toBeTypeOf('string')
  })

  it('returns undefined when CWC_DISABLE_AUTH=1 (dev escape hatch)', () => {
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '1' })).toBeUndefined()
  })

  it('only disables on the exact value "1", not any truthy string', () => {
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: 'true' })).toBeTypeOf('string')
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '0' })).toBeTypeOf('string')
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '' })).toBeTypeOf('string')
  })

  it('returns a fresh token each call', () => {
    expect(resolveAuthToken({})).not.toBe(resolveAuthToken({}))
  })
})

describe('restrictCors', () => {
  it('allows non-browser clients with no Origin (curl, spawned claude run-logger)', () => {
    const { nexted, statusCode } = run(restrictCors([]), { method: 'POST' })
    expect(nexted).toBe(true)
    expect(statusCode).toBeNull()
  })

  it('allows same-origin requests (Origin host matches Host header)', () => {
    const { nexted, cors } = run(restrictCors([]), {
      origin: 'http://localhost:3579', host: 'localhost:3579',
    })
    expect(nexted).toBe(true)
    expect(cors).toBe('http://localhost:3579')
  })

  it('with allowLoopback, accepts a loopback Origin whose Host was rewritten (real Vite dev case)', () => {
    // Vite forwards Origin :5173 but rewrites Host to the :3579 target, so this is NOT same-origin.
    const { nexted } = run(restrictCors([], { allowLoopback: true }), {
      method: 'POST', origin: 'http://localhost:5173', host: 'localhost:3579',
    })
    expect(nexted).toBe(true)
  })

  it('without allowLoopback (packaged mode), that same loopback cross-origin is rejected', () => {
    const { nexted, statusCode } = run(restrictCors([]), {
      method: 'POST', origin: 'http://localhost:5173', host: 'localhost:3579',
    })
    expect(nexted).toBe(false)
    expect(statusCode).toBe(403)
  })

  it('allowLoopback still rejects a non-loopback foreign origin', () => {
    const { nexted, statusCode } = run(restrictCors([], { allowLoopback: true }), {
      method: 'POST', origin: 'http://evil.example', host: 'localhost:3579',
    })
    expect(nexted).toBe(false)
    expect(statusCode).toBe(403)
  })

  it('allows an explicitly allowlisted cross-origin', () => {
    const { nexted, cors } = run(restrictCors(['https://app.example.com']), {
      origin: 'https://app.example.com', host: 'localhost:3579',
    })
    expect(nexted).toBe(true)
    expect(cors).toBe('https://app.example.com')
  })

  it('rejects a disallowed cross-origin request outright (no side effects)', () => {
    const { nexted, statusCode } = run(restrictCors([]), {
      method: 'POST', origin: 'http://evil.example', host: 'localhost:3579',
    })
    expect(nexted).toBe(false)
    expect(statusCode).toBe(403)
  })

  it('answers same-origin preflight with 204', () => {
    const { statusCode } = run(restrictCors([]), {
      method: 'OPTIONS', origin: 'http://localhost:3579', host: 'localhost:3579',
    })
    expect(statusCode).toBe(204)
  })
})
