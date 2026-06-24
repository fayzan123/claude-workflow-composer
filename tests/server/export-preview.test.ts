import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createApp } from '../../src/server/index.js'
import type { CwcFile } from '../../src/schema.js'

const FIXTURE: CwcFile = {
  meta: { id: 'preview-uuid', name: 'Preview Test', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, startTrigger: 'to implement', agent: { name: 'Developer', description: 'Builds things', completionCriteria: 'Task complete', tools: ['Read','Write'], model: 'inherit' } }],
  edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'The workflow is complete.', terminalType: 'complete', context: [] }],
}

let server: http.Server
let port: number

beforeAll(async () => {
  const app = createApp({ staticDir: null })
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() }) })
})
afterAll(() => server.close())

it('POST /api/export/preview returns file contents without writing to disk', async () => {
  const res = await fetch(`http://localhost:${port}/api/export/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwcFile: FIXTURE, target: { type: 'user' } }),
  })
  expect(res.status).toBe(200)
  const { files, warnings } = await res.json() as { files: { path: string; content: string }[]; warnings: string[] }
  expect(files.length).toBeGreaterThanOrEqual(1)
  const agentFile = files.find((f) => f.path.endsWith('developer.md'))
  expect(agentFile).toBeDefined()
  expect(agentFile!.content).toContain('name: developer')
  expect(agentFile!.content).toContain('## Completion Criteria')
  expect(Array.isArray(warnings)).toBe(true)
})
