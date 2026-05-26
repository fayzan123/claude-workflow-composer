import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
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
  it('returns 200 with status ok', async () => {
    const { status, body } = await get('/api/health')
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('ok')
  })
})
