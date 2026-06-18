import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let dir: string, server: http.Server, base: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wflist-'))
  const workflowPath = path.join(dir, 'a.cwc')
  await fs.writeFile(workflowPath, JSON.stringify({
    meta: { id: 'wf-abc', name: 'Alpha', description: '', version: 1, created: '', updated: '2026-06-18T00:00:00.000Z' },
    nodes: [], edges: [],
  }))
  const mtime = new Date('2026-06-18T20:00:00.000Z')
  await fs.utimes(workflowPath, mtime, mtime)
  const app = createApp({ staticDir: null, workflowsDir: dir, enableNotifier: false })
  server = app.listen(0); base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }) })

it('GET /workflows/list includes meta.id', async () => {
  const items = await (await fetch(`${base}/api/workflows/list`)).json() as Array<{ id: string; name: string }>
  const alpha = items.find(i => i.name === 'Alpha')
  expect(alpha?.id).toBe('wf-abc')
})

it('GET /workflows/list uses file mtime when embedded metadata is stale', async () => {
  const items = await (await fetch(`${base}/api/workflows/list`)).json() as Array<{ id: string; name: string; updated: string }>
  const alpha = items.find(i => i.name === 'Alpha')
  expect(alpha?.updated).toBe('2026-06-18T20:00:00.000Z')
})
