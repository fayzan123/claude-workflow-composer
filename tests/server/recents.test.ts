import { it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import http from 'node:http'

let server: http.Server
let tmpDir: string
let recentsFile: string
let port: number

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-recents-'))
  recentsFile = path.join(tmpDir, 'recents.json')
  const app = createApp({ staticDir: null, recentsPath: recentsFile })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpDir, { recursive: true })
})

it('GET /api/recents returns empty array when file does not exist', async () => {
  const res = await fetch(`http://localhost:${port}/api/recents`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([])
})

it('POST /api/recents adds a path and returns updated list', async () => {
  const res = await fetch(`http://localhost:${port}/api/recents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/home/user/workflow.cwc' }),
  })
  expect(res.status).toBe(200)
  const list = await res.json() as string[]
  expect(list[0]).toBe('/home/user/workflow.cwc')
})

it('POST /api/recents deduplicates: re-adding moves item to front', async () => {
  await fetch(`http://localhost:${port}/api/recents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/a.cwc' }) })
  await fetch(`http://localhost:${port}/api/recents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/b.cwc' }) })
  const res = await fetch(`http://localhost:${port}/api/recents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/a.cwc' }) })
  const list = await res.json() as string[]
  expect(list[0]).toBe('/a.cwc')
  expect(list.filter((p) => p === '/a.cwc').length).toBe(1) // no duplicate
})

it('POST /api/recents truncates to 10 entries', async () => {
  for (let i = 0; i < 12; i++) {
    await fetch(`http://localhost:${port}/api/recents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `/workflow-${i}.cwc` }) })
  }
  const res = await fetch(`http://localhost:${port}/api/recents`)
  const list = await res.json() as string[]
  expect(list.length).toBeLessThanOrEqual(10)
})
