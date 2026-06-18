import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { createApp } from '../../src/server/index.js'

let server: http.Server

beforeAll(async () => {
  const app = createApp({ staticDir: null })
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
})

afterAll(() => { server.close() })

function get(path: string): Promise<{ status: number; body: unknown }> {
  const addr = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${addr.port}${path}`, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    }).on('error', reject)
  })
}

describe('GET /api/health', () => {
  it('returns 200 with status ok and the real package version', async () => {
    const { status, body } = await get('/api/health')
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('ok')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'))
    expect((body as { version: string }).version).toBe(pkg.version)
  })

  it('keeps health public but protects other APIs when auth is enabled', async () => {
    const app = createApp({ staticDir: null, authToken: 'test-token' })
    let authServer!: http.Server
    await new Promise<void>((resolve) => {
      authServer = app.listen(0, resolve)
    })
    const addr = authServer.address() as { port: number }
    try {
      const health = await fetch(`http://localhost:${addr.port}/api/health`)
      expect(health.status).toBe(200)

      const blocked = await fetch(`http://localhost:${addr.port}/api/claude-check`)
      expect(blocked.status).toBe(401)

      const allowed = await fetch(`http://localhost:${addr.port}/api/claude-check`, {
        headers: { 'X-CWC-Token': 'test-token' },
      })
      expect(allowed.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()))
    }
  })
})
