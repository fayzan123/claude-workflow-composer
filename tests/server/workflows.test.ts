import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import type { CwcFile } from '../../src/schema.js'

let server: http.Server
let tmpDir: string
let port: number

const FIXTURE_CWC: CwcFile = {
  meta: { id: 'test-uuid', name: 'Test Workflow', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [], edges: [],
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-test-'))
  const app = createApp({ staticDir: null, workflowsDir: tmpDir })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpDir, { recursive: true })
})

async function httpGet(urlPath: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    }).on('error', reject)
  })
}

async function httpPost(urlPath: string, body: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.write(payload); req.end()
  })
}

async function httpDelete(urlPath: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'DELETE' }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.end()
  })
}

it('POST /api/workflows saves a .cwc file', async () => {
  const filePath = path.join(tmpDir, 'test.cwc')
  const { status, body } = await httpPost('/api/workflows', { path: filePath, content: FIXTURE_CWC })
  expect(status).toBe(200)
  expect((body as { saved: boolean }).saved).toBe(true)
  const raw = await fs.readFile(filePath, 'utf-8')
  expect(JSON.parse(raw).meta.name).toBe('Test Workflow')
})

it('GET /api/workflows?path reads a saved .cwc file', async () => {
  const filePath = path.join(tmpDir, 'test.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpGet(`/api/workflows?path=${encodeURIComponent(filePath)}`)
  expect(status).toBe(200)
  expect((body as CwcFile).meta.id).toBe('test-uuid')
})

it('GET /api/workflows/list returns .cwc files in workflowsDir', async () => {
  const filePath = path.join(tmpDir, 'listed.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpGet('/api/workflows/list')
  expect(status).toBe(200)
  const items = body as { path: string; name: string }[]
  expect(items.some((i) => i.path === filePath && i.name === 'Test Workflow')).toBe(true)
})

it('GET /api/workflows?path returns 404 for missing file', async () => {
  const { status } = await httpGet(`/api/workflows?path=${encodeURIComponent('/tmp/does-not-exist.cwc')}`)
  expect(status).toBe(404)
})

it('DELETE /api/workflows deletes the file', async () => {
  const filePath = path.join(tmpDir, 'to-delete.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)
  expect(status).toBe(200)
  expect((body as { deleted: boolean }).deleted).toBe(true)
  await expect(fs.access(filePath)).rejects.toThrow()
})
