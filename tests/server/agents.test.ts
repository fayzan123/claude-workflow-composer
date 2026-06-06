import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import type { AgentEntry } from '../../src/server/api/agents.js'

let server: http.Server
let tmpUserDir: string
let tmpProjectDir: string
let port: number

beforeAll(async () => {
  tmpUserDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-agents-user-'))
  tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-agents-proj-'))

  // Fake user agent
  const userAgentsDir = path.join(tmpUserDir, '.claude', 'agents')
  await fs.mkdir(userAgentsDir, { recursive: true })
  await fs.writeFile(path.join(userAgentsDir, 'senior-dev.md'),
    '---\nname: Senior Dev\ndescription: Writes clean code\n---\nYou are a senior developer.', 'utf-8')

  // Fake project agent
  const projAgentsDir = path.join(tmpProjectDir, '.claude', 'agents')
  await fs.mkdir(projAgentsDir, { recursive: true })
  await fs.writeFile(path.join(projAgentsDir, 'tester.md'),
    '---\nname: Tester\ndescription: Writes tests\n---\nYou write tests.', 'utf-8')

  const app = createApp({ staticDir: null, userHomeDir: tmpUserDir })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpUserDir, { recursive: true })
  await fs.rm(tmpProjectDir, { recursive: true })
})

it('GET /api/agents returns user-scoped agents', async () => {
  const res = await fetch(`http://localhost:${port}/api/agents`)
  expect(res.status).toBe(200)
  const agents = await res.json() as AgentEntry[]
  const found = agents.find((a) => a.slug === 'senior-dev')
  expect(found).toBeDefined()
  expect(found!.name).toBe('Senior Dev')
  expect(found!.source).toBe('user')
})

it('GET /api/agents?projectDir includes project-scoped agents', async () => {
  const res = await fetch(`http://localhost:${port}/api/agents?projectDir=${encodeURIComponent(tmpProjectDir)}`)
  const agents = await res.json() as AgentEntry[]
  const projAgent = agents.find((a) => a.slug === 'tester')
  expect(projAgent).toBeDefined()
  expect(projAgent!.source).toBe('project')
})

it('GET /api/agents returns empty array when agents dir is missing', async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-empty-'))
  const res = await fetch(`http://localhost:${port}/api/agents?projectDir=${encodeURIComponent(emptyDir)}`)
  const agents = await res.json() as AgentEntry[]
  expect(Array.isArray(agents)).toBe(true)
  await fs.rm(emptyDir, { recursive: true })
})

async function postAgent(body: unknown) {
  const res = await fetch(`http://localhost:${port}/api/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as any }
}

it('POST /api/agents writes a new agent file and returns its slug', async () => {
  const content = '---\nname: Migration Reviewer\ndescription: Audits migrations.\n---\nYou are **Migration Reviewer**.'
  const { status, json } = await postAgent({ slug: 'migration-reviewer', content })
  expect(status).toBe(200)
  expect(json.slug).toBe('migration-reviewer')
  const written = await fs.readFile(path.join(tmpUserDir, '.claude', 'agents', 'migration-reviewer.md'), 'utf-8')
  expect(written).toContain('name: Migration Reviewer')
})

it('POST /api/agents returns 409 when the slug exists and overwrite is not set', async () => {
  const content = '---\nname: Dup\ndescription: d\n---\nbody'
  await postAgent({ slug: 'dup-agent', content })
  const { status, json } = await postAgent({ slug: 'dup-agent', content })
  expect(status).toBe(409)
  expect(json.error).toMatch(/exists/i)
})

it('POST /api/agents overwrites when overwrite:true', async () => {
  const a = '---\nname: Over\ndescription: v1\n---\nbody'
  const b = '---\nname: Over\ndescription: v2\n---\nbody'
  await postAgent({ slug: 'over-agent', content: a })
  const { status } = await postAgent({ slug: 'over-agent', content: b, overwrite: true })
  expect(status).toBe(200)
  const written = await fs.readFile(path.join(tmpUserDir, '.claude', 'agents', 'over-agent.md'), 'utf-8')
  expect(written).toContain('v2')
})

it('POST /api/agents rejects a slug with path traversal', async () => {
  const { status } = await postAgent({ slug: '../evil', content: '---\nname: x\ndescription: y\n---\nb' })
  expect(status).toBe(400)
})
