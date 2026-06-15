import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let home: string
let server: http.Server
let base: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-cand-'))
  const proj = path.join(home, '.claude', 'projects', 'p1')
  await fs.mkdir(proj, { recursive: true })
  const L = (o: unknown) => JSON.stringify(o) + '\n'
  const push = (ts: string) => [
    L({ type: 'user', sessionId: 'S', cwd: '/r', timestamp: ts, promptId: 'p' + ts, message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } }),
    L({ type: 'assistant', sessionId: 'S', cwd: '/r', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test && git push' } }] } }),
  ].join('')
  await fs.writeFile(
    path.join(proj, 'S.jsonl'),
    push('2026-06-01T10:00:00Z') + push('2026-06-02T10:00:00Z') + push('2026-06-03T10:00:00Z')
  )
  const app = createApp({ staticDir: null, userHomeDir: home, enableNotifier: false })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.close()
  await fs.rm(home, { recursive: true, force: true })
})

describe('GET /api/automation-candidates', () => {
  it('returns detected candidates from the user transcript history', async () => {
    const res = await fetch(`${base}/api/automation-candidates`)
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ signature: string; count: number }>
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(body[0].signature).toBe('tests+git-push')
    expect(body[0].count).toBe(3)
  })
})
