import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createApp } from '../../src/server/index.js'
import type { ClaudeRunner } from '../../src/server/claude-runner.js'

let server: http.Server
let port: number

const SPEC_JSON = JSON.stringify({
  name: 'migration-reviewer',
  description: 'Use when reviewing SQL migrations.',
  steps: ['Read it', 'Check locks'],
})

const fakeRunner: ClaudeRunner = (prompt) => {
  if (prompt.includes('TRIGGER_FAIL')) return Promise.reject(new Error('runner boom'))
  if (prompt.startsWith('Write the body of a Claude Code skill')) {
    return Promise.resolve({ result: '# migration-reviewer\n\nReview migrations.', sessionId: 'sess-1' })
  }
  return Promise.resolve({ result: SPEC_JSON, sessionId: 'sess-1' })
}

beforeAll(async () => {
  const app = createApp({ staticDir: null, claudeRunner: fakeRunner })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

async function post(p: string, body: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as any }
}

it('POST /api/skills/generate/spec returns a parsed spec + sessionId', async () => {
  const { status, json } = await post('/api/skills/generate/spec', { message: 'review migrations' })
  expect(status).toBe(200)
  expect(json.spec.name).toBe('migration-reviewer')
  expect(json.spec.steps).toEqual(['Read it', 'Check locks'])
  expect(json.sessionId).toBe('sess-1')
})

it('POST /api/skills/generate/build returns assembled SKILL.md + slug', async () => {
  const spec = JSON.parse(SPEC_JSON)
  const { status, json } = await post('/api/skills/generate/build', { spec, sessionId: 'sess-1' })
  expect(status).toBe(200)
  expect(json.content).toContain('name: migration-reviewer')
  expect(json.content).toContain('Review migrations.')
  expect(json.slug).toBe('migration-reviewer')
})

it('POST /api/skills/generate/spec returns 400 when message missing', async () => {
  const { status } = await post('/api/skills/generate/spec', {})
  expect(status).toBe(400)
})

it('POST /api/skills/generate/spec returns 502 when the runner fails', async () => {
  const { status, json } = await post('/api/skills/generate/spec', { message: 'TRIGGER_FAIL' })
  expect(status).toBe(502)
  expect(json.error).toMatch(/boom/)
})
