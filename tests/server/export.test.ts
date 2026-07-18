import { it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import http from 'node:http'
import type { CwcFile } from '../../src/schema.js'
import type { ExportResult } from '../../src/export/exporter.js'

let server: http.Server
let tmpAgentsDir: string
let tmpSkillsDir: string
let workflowsDir: string
let port: number

const FIXTURE: CwcFile = {
  meta: { id: 'export-uuid', name: 'Export Test', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'Developer', description: 'Builds things', completionCriteria: 'Done', tools: ['Read'], model: 'inherit' } }],
  edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'Workflow complete.', terminalType: 'complete', context: [] }],
}

beforeAll(async () => {
  tmpAgentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-export-agents-'))
  tmpSkillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-export-skills-'))
  workflowsDir = path.join(tmpAgentsDir, 'workflows')
  const app = createApp({
    staticDir: null,
    workflowsDir,
    userHomeDir: path.join(tmpAgentsDir, 'home'),
    enableNotifier: false,
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpAgentsDir, { recursive: true })
  await fs.rm(tmpSkillsDir, { recursive: true })
})

it('POST /api/export writes agent .md and skill .md, returns updatedCwc with exportedSlug', async () => {
  const created = await fetch(`http://localhost:${port}/api/workflows/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: FIXTURE }),
  })
  expect(created.status).toBe(201)
  const authority = await created.json() as { path: string; revision: string }
  const res = await fetch(`http://localhost:${port}/api/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwcFile: FIXTURE,
      target: { type: 'project', projectDir: tmpAgentsDir },
      skillsDir: tmpSkillsDir,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    }),
  })
  expect(res.status).toBe(200)
  const { updatedCwc, warnings } = await res.json() as ExportResult

  // exportedSlug populated for the node
  expect(updatedCwc.nodes[0].exportedSlug).toBe('developer')

  // Agent .md file written
  const agentFile = path.join(tmpAgentsDir, '.claude', 'agents', 'developer.md')
  const agentContent = await fs.readFile(agentFile, 'utf-8')
  expect(agentContent).toContain('name: developer')
  expect(agentContent).toContain('## Completion Criteria')

  // Workflow skill written
  const skillFile = path.join(tmpSkillsDir, 'cwc-export-test', 'SKILL.md')
  const skillContent = await fs.readFile(skillFile, 'utf-8')
  expect(skillContent).toContain('disable-model-invocation: true')
  expect(skillContent).toContain('<!-- cwc:workflow:export-uuid -->')

  expect(Array.isArray(warnings)).toBe(true)
})

it('POST /api/export returns 400 when cwcFile is missing', async () => {
  const res = await fetch(`http://localhost:${port}/api/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { type: 'user' } }),
  })
  expect(res.status).toBe(400)
})
