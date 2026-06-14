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
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-svc-'))
  const app = createApp({ staticDir: null, userHomeDir: home })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.close()
  await fs.rm(home, { recursive: true, force: true })
})

describe('GET /api/service-status', () => {
  it('reports not-persistent when no plist is installed', async () => {
    const res = await fetch(`${base}/api/service-status`)
    expect(res.status).toBe(200)
    const body = await res.json() as { persistent: boolean }
    expect(body.persistent).toBe(false)
  })
  it('reports persistent when the plist exists', async () => {
    const dir = path.join(home, 'Library', 'LaunchAgents')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'com.cwc.server.plist'), '<plist/>')
    const res = await fetch(`${base}/api/service-status`)
    const body = await res.json() as { persistent: boolean }
    expect(body.persistent).toBe(true)
  })
})
