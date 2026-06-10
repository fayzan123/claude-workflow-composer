// tests/server/runs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let runsDir: string
let server: http.Server
let base: string

function ev(over: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'cwc-x',
    type: 'step_started', ts: new Date().toISOString(), ...over,
  }
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-runs-api-'))
  const app = createApp({ staticDir: null, runsDir })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.close()
  await fs.rm(runsDir, { recursive: true })
})

describe('POST /api/runs/events', () => {
  it('persists a valid event', async () => {
    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()),
    })
    expect(res.status).toBe(200)
    const raw = await fs.readFile(path.join(runsDir, 'wf-1', 'run-1.jsonl'), 'utf-8')
    expect(JSON.parse(raw.trim()).type).toBe('step_started')
  })

  it('rejects malformed events with 400 and a reason', async () => {
    const res = await fetch(`${base}/api/runs/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: true }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })
})

describe('GET /api/runs', () => {
  it('lists summaries for a workflow', async () => {
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_started' })) })
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_completed', status: 'complete' })) })
    const res = await fetch(`${base}/api/runs?workflowId=wf-1`)
    const runs = (await res.json()) as { runId: string; status: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: 'run-1', status: 'complete' })
  })

  it('400 without workflowId; [] for unknown workflow', async () => {
    expect((await fetch(`${base}/api/runs`)).status).toBe(400)
    const res = await fetch(`${base}/api/runs?workflowId=ghost`)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /api/runs/:runId/events', () => {
  it('returns the ordered event list', async () => {
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev({ type: 'run_started' })) })
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()) })
    const res = await fetch(`${base}/api/runs/run-1/events?workflowId=wf-1`)
    const events = (await res.json()) as { type: string }[]
    expect(events.map(e => e.type)).toEqual(['run_started', 'step_started'])
  })

  it('404 for unknown run', async () => {
    expect((await fetch(`${base}/api/runs/ghost/events?workflowId=wf-1`)).status).toBe(404)
  })
})

describe('GET /api/runs/stream (SSE)', () => {
  it('delivers ingested events to a connected client', async () => {
    const received: string[] = []
    const req = http.get(`${base}/api/runs/stream`, res => {
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => received.push(chunk))
    })
    await new Promise(r => setTimeout(r, 150)) // let the stream connect
    await fetch(`${base}/api/runs/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev()) })
    await new Promise(r => setTimeout(r, 150))
    req.destroy()
    const all = received.join('')
    expect(all).toContain('data: ')
    expect(all).toContain('"runId":"run-1"')
  })
})
