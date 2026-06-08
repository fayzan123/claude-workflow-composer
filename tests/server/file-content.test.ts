import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'

let server: http.Server
let port: number
let tmpUserDir: string
let agentFile: string

beforeAll(async () => {
  tmpUserDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-filecontent-'))
  const agentsDir = path.join(tmpUserDir, '.claude', 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  agentFile = path.join(agentsDir, 'a.md')
  await fs.writeFile(agentFile, '---\nname: A\ndescription: d\n---\noriginal', 'utf-8')
  const app = createApp({ staticDir: null, userHomeDir: tmpUserDir })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpUserDir, { recursive: true })
})

async function post(body: unknown) {
  const res = await fetch(`http://localhost:${port}/api/file-content`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as any }
}

it('GET /api/file-content still reads a file under .claude', async () => {
  const res = await fetch(`http://localhost:${port}/api/file-content?path=${encodeURIComponent(agentFile)}`)
  expect(res.status).toBe(200)
  expect((await res.json() as any).content).toContain('original')
})

it('POST /api/file-content writes back to an existing file', async () => {
  const { status, json } = await post({ path: agentFile, content: '---\nname: A\ndescription: d\n---\nedited' })
  expect(status).toBe(200)
  expect(json.saved).toBe(true)
  expect(await fs.readFile(agentFile, 'utf-8')).toContain('edited')
})

it('POST returns 403 for a path outside .claude', async () => {
  const outside = path.join(tmpUserDir, 'outside.md')
  await fs.writeFile(outside, 'x', 'utf-8')
  const { status } = await post({ path: outside, content: 'hacked' })
  expect(status).toBe(403)
})

it('POST returns 404 for a non-existent file (edit, not create)', async () => {
  const missing = path.join(tmpUserDir, '.claude', 'agents', 'nope.md')
  const { status } = await post({ path: missing, content: 'x' })
  expect(status).toBe(404)
})

it('POST returns 400 for empty content', async () => {
  const { status } = await post({ path: agentFile, content: '   ' })
  expect(status).toBe(400)
})
