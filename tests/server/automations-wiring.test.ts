// tests/server/automations-wiring.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let tmpDir: string
let workflowsDir: string
let runsDir: string
let statePath: string
let configPath: string
let wtRoot: string
let server: http.Server
let base: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wire-'))
  workflowsDir = path.join(tmpDir, 'workflows')
  runsDir = path.join(tmpDir, 'runs')
  statePath = path.join(tmpDir, 'automation-state.json')
  configPath = path.join(tmpDir, 'config.json')
  wtRoot = path.join(tmpDir, 'worktrees')
  await fs.mkdir(workflowsDir, { recursive: true })
  await fs.mkdir(runsDir, { recursive: true })
  await fs.mkdir(wtRoot, { recursive: true })

  const app = createApp({
    staticDir: null,
    workflowsDir,
    runsDir,
    worktreesRoot: wtRoot,
    automationStatePath: statePath,
    configPath,
    enableScheduler: false,
    enableNotifier: false,
  })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('GET /api/automations/state', () => {
  it('returns paused: false initially', async () => {
    const res = await fetch(`${base}/api/automations/state`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ paused: false })
  })
})

describe('PUT /api/automations/state', () => {
  it('flips paused flag and returns new state', async () => {
    const res = await fetch(`${base}/api/automations/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ paused: true })

    // GET now shows updated state
    const getRes = await fetch(`${base}/api/automations/state`)
    const getBody = await getRes.json() as Record<string, unknown>
    expect(getBody).toEqual({ paused: true })
  })
})

describe('POST /api/automations/arm + GET /api/automations/trigger-state/:id', () => {
  it('arms a trigger and shows armedHash in trigger-state', async () => {
    const trigger = {
      id: 'trig-arm-1',
      type: 'cron' as const,
      schedule: '0 * * * *',
      cwd: workflowsDir,
      isolation: 'in-place' as const,
      catchUp: false,
      maxRunsPerDay: 5,
      enabled: true,
    }
    const armRes = await fetch(`${base}/api/automations/arm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger }),
    })
    expect(armRes.status).toBe(200)
    const armBody = await armRes.json() as Record<string, unknown>
    expect(armBody).toEqual({ armed: true })

    const stateRes = await fetch(`${base}/api/automations/trigger-state/trig-arm-1`)
    expect(stateRes.status).toBe(200)
    const stateBody = await stateRes.json() as Record<string, unknown>
    expect(typeof stateBody.armedHash).toBe('string')
    expect((stateBody.armedHash as string).length).toBeGreaterThan(0)
  })
})

describe('GET /PUT /api/automations/config', () => {
  it('round-trips config', async () => {
    const getRes = await fetch(`${base}/api/automations/config`)
    expect(getRes.status).toBe(200)

    const putRes = await fetch(`${base}/api/automations/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { macos: false, webhookUrl: 'http://example.com/hook' } }),
    })
    expect(putRes.status).toBe(200)
    const putBody = await putRes.json() as Record<string, unknown>
    expect((putBody as { notifications: { webhookUrl: string } }).notifications.webhookUrl).toBe('http://example.com/hook')

    // GET now returns the updated config
    const getRes2 = await fetch(`${base}/api/automations/config`)
    const getBody2 = await getRes2.json() as Record<string, unknown>
    expect((getBody2 as { notifications: { webhookUrl: string } }).notifications.webhookUrl).toBe('http://example.com/hook')
  })
})

describe('POST /api/triggers/:unknown', () => {
  it('returns 404 for unknown trigger token', async () => {
    const res = await fetch(`${base}/api/triggers/completely-unknown-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})
