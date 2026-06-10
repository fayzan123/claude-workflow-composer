// tests/server/run-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import type { RunEvent } from '../../src/run-events.js'

let dir: string
let store: RunStore

function ev(over: Partial<RunEvent>): RunEvent {
  return {
    runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'cwc-x',
    type: 'step_started', ts: new Date().toISOString(), ...over,
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-runs-'))
  store = createRunStore(dir)
})
afterEach(async () => { await fs.rm(dir, { recursive: true }) })

describe('RunStore', () => {
  it('appends events as JSONL lines', async () => {
    await store.append(ev({ type: 'run_started' }))
    await store.append(ev({ type: 'step_started', nodeId: 'n1' }))
    const lines = (await fs.readFile(path.join(dir, 'wf-1', 'run-1.jsonl'), 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).nodeId).toBe('n1')
  })

  it('getEvents returns ordered events; null for unknown run', async () => {
    await store.append(ev({ type: 'run_started' }))
    await store.append(ev({ type: 'run_completed', status: 'complete' }))
    const events = await store.getEvents('wf-1', 'run-1')
    expect(events?.map(e => e.type)).toEqual(['run_started', 'run_completed'])
    expect(await store.getEvents('wf-1', 'nope')).toBeNull()
  })

  it('listRuns computes summaries: completed run', async () => {
    await store.append(ev({ type: 'run_started', ts: '2026-06-09T10:00:00.000Z', source: 'test', cwd: '/proj' }))
    await store.append(ev({ type: 'run_completed', status: 'complete', ts: '2026-06-09T10:05:00.000Z' }))
    const [run] = await store.listRuns('wf-1')
    expect(run).toMatchObject({ runId: 'run-1', status: 'complete', source: 'test', cwd: '/proj' })
    expect(run.durationMs).toBe(5 * 60_000)
  })

  it('listRuns marks a recently active run as running', async () => {
    await store.append(ev({ type: 'step_started' }))
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('running')
  })

  it('listRuns marks a silent unfinished run as stale after 15 min', async () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString()
    await store.append(ev({ type: 'step_started', ts: old }))
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('stale')
  })

  it('listRuns defaults source to external and sorts newest first', async () => {
    await store.append(ev({ runId: 'run-old', type: 'step_started', ts: '2026-06-09T09:00:00.000Z' }))
    await store.append(ev({ runId: 'run-new', type: 'step_started', ts: new Date().toISOString() }))
    const runs = await store.listRuns('wf-1')
    expect(runs.map(r => r.runId)).toEqual(['run-new', 'run-old'])
    expect(runs[0].source).toBe('external')
  })

  it('listRuns returns [] for unknown workflow', async () => {
    expect(await store.listRuns('nope')).toEqual([])
  })

  it('notifies subscribers on append; unsubscribe works', async () => {
    const seen: string[] = []
    const off = store.onEvent(e => seen.push(e.type))
    await store.append(ev({ type: 'run_started' }))
    off()
    await store.append(ev({ type: 'step_started' }))
    expect(seen).toEqual(['run_started'])
  })

  it('tracks active test runs per workflow and stops them by runId', async () => {
    let stops = 0
    store.registerRun('run-1', 'wf-1', () => { stops++ })
    expect(store.hasActiveTestRun('wf-1')).toBe(true)
    expect(store.stopRun('run-1')).toBe(true)
    expect(stops).toBe(1)
    store.releaseRun('run-1')
    expect(store.stopRun('run-1')).toBe(false)
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })
})
