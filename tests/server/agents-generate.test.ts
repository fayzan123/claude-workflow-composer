import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createApp } from '../../src/server/index.js'
import type { ClaudeRunner } from '../../src/server/claude-runner.js'

let server: http.Server
let port: number

const SPEC_JSON = JSON.stringify({
  name: 'Migration Reviewer',
  description: 'Audits SQL migrations for safety.',
  whenToUse: 'Before applying any migration.',
  suggestedTools: ['Read', 'Bash'],
  suggestedColor: 'red',
  keyBehaviors: ['Checks locks'],
})

// Fake runner: returns spec JSON unless the prompt asks for a body.
const fakeRunner: ClaudeRunner = (prompt) => {
  if (prompt.includes('TRIGGER_FAIL')) {
    return Promise.reject(new Error('runner boom'))
  }
  if (prompt.startsWith('Write the system prompt body')) {
    return Promise.resolve({ result: '# Migration Reviewer\n\nYou are **Migration Reviewer**.', sessionId: 'sess-abc' })
  }
  return Promise.resolve({ result: SPEC_JSON, sessionId: 'sess-abc' })
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

it('POST /api/agents/generate/spec returns a parsed spec + sessionId', async () => {
  const { status, json } = await post('/api/agents/generate/spec', { message: 'review my SQL migrations' })
  expect(status).toBe(200)
  expect(json.spec.name).toBe('Migration Reviewer')
  expect(json.spec.suggestedTools).toEqual(['Read', 'Bash'])
  expect(json.sessionId).toBe('sess-abc')
})

it('POST /api/agents/generate/build returns assembled agent markdown', async () => {
  const spec = JSON.parse(SPEC_JSON)
  const { status, json } = await post('/api/agents/generate/build', { spec, sessionId: 'sess-abc' })
  expect(status).toBe(200)
  expect(json.content).toContain('name: Migration Reviewer')
  expect(json.content).toContain('You are **Migration Reviewer**')
  expect(json.slug).toBe('migration-reviewer')
})

it('POST /api/agents/generate/spec returns 400 when message is missing', async () => {
  const { status } = await post('/api/agents/generate/spec', {})
  expect(status).toBe(400)
})

it('POST /api/agents/generate/build returns 400 when spec is missing', async () => {
  const { status } = await post('/api/agents/generate/build', {})
  expect(status).toBe(400)
})

it('POST /api/agents/generate/spec returns 502 when the runner fails', async () => {
  const { status, json } = await post('/api/agents/generate/spec', { message: 'TRIGGER_FAIL please' })
  expect(status).toBe(502)
  expect(json.error).toMatch(/boom/)
})
