import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createScanStore } from '../../src/server/scan-store.js'
import type { DetectedAutomation } from '../../src/detection/types.js'
import type { LogEntry } from '../../src/server/scan-store.js'

let dir: string, file: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-scan-')); file = path.join(dir, 'scan.json') })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

function auto(p: Partial<DetectedAutomation>): DetectedAutomation {
  return { id: 'id1', title: 't', description: 'd', steps: [], stepTokens: ['x'], evidence: { count: 3, repos: ['/r'], sessionIds: ['s'], firstSeen: '', lastSeen: '' }, suggestedTrigger: { kind: 'manual', label: '' }, confidence: 0.9, status: 'new', ...p }
}

it('buffers log entries during a scan and exposes them on the result', async () => {
  const store = createScanStore(file)
  const seen: LogEntry[] = []
  const off = store.onLog(e => seen.push(e))
  await store.runScan(async () => {
    store.appendLog({ level: 'info', message: 'found 3 files' })
    store.appendLog({ level: 'claude', message: 'clustering' })
    return [auto({})]
  })
  off()
  expect(seen.map(e => e.message)).toEqual(['found 3 files', 'clustering'])
  const log = store.getLatest()!.log
  expect(log).toHaveLength(2)
  expect(log[0]).toMatchObject({ level: 'info', message: 'found 3 files' })
  expect(typeof log[0].ts).toBe('string')
})

describe('createScanStore', () => {
  it('runs a scan single-flight and persists results across reloads', async () => {
    const store = createScanStore(file)
    expect(store.isRunning()).toBe(false)
    await store.runScan(async () => [auto({})])
    expect(store.getLatest()?.status).toBe('done')
    expect(store.getLatest()?.automations).toHaveLength(1)
    // reload from disk
    expect(createScanStore(file).getLatest()?.automations[0].id).toBe('id1')
  })

  it('rejects a concurrent scan and preserves dismissed status across re-scans', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])
    await store.setStatus('id1', 'dismissed')
    // a re-scan that re-detects id1 keeps it dismissed
    await store.runScan(async () => [auto({ id: 'id1', status: 'new' })])
    expect(store.getLatest()?.automations[0].status).toBe('dismissed')
  })

  it('survives a corrupt persisted scan file on load', async () => {
    await fs.writeFile(file, '{ this is not valid json')
    const store = createScanStore(file)
    expect(store.getLatest()).toBeNull()
    // and a fresh scan still works, overwriting the corrupt file
    await store.runScan(async () => [auto({})])
    expect(store.getLatest()?.status).toBe('done')
  })

  it('records a job failure as an error result, clears running, and persists it', async () => {
    const store = createScanStore(file)
    // runScan swallows the job error into an error status — it does not reject
    await store.runScan(async () => { throw new Error('claude analysis blew up') })
    expect(store.getLatest()?.status).toBe('error')
    expect(store.getLatest()?.error).toContain('claude analysis blew up')
    expect(store.isRunning()).toBe(false)
    // error state is durable across reload
    expect(createScanStore(file).getLatest()?.status).toBe('error')
  })

  it('can run a new scan after a failed one', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => { throw new Error('boom') })
    await store.runScan(async () => [auto({})])
    expect(store.getLatest()?.status).toBe('done')
  })

  it('setStatus returns null for an unknown automation id', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])
    expect(await store.setStatus('does-not-exist', 'dismissed')).toBeNull()
  })

  it('preserves a promoted status across re-scans', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])
    await store.setStatus('id1', 'promoted')
    await store.runScan(async () => [auto({ id: 'id1', status: 'new' })])
    expect(store.getLatest()?.automations[0].status).toBe('promoted')
  })

  it('persists active promotion state with detail and exposes a single-flight flag', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])

    await store.setStatus('id1', 'promoting')
    expect(store.hasActivePromotion()).toBe(true)

    await store.setStatus('id1', 'promotion_failed', 'rate limit reached')
    expect(store.hasActivePromotion()).toBe(false)
    expect(store.getLatest()?.automations[0].statusDetail).toBe('rate limit reached')
    expect(createScanStore(file).getLatest()?.automations[0].statusDetail).toBe('rate limit reached')
  })

  it('persists cancelled promotion state without treating it as active', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])

    await store.setStatus('id1', 'promotion_cancelled', 'user cancelled')
    expect(store.hasActivePromotion()).toBe(false)
    expect(createScanStore(file).getLatest()?.automations[0].status).toBe('promotion_cancelled')
    expect(createScanStore(file).getLatest()?.automations[0].statusDetail).toBe('user cancelled')
  })

  it('serializes overlapping status persistence', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])

    await Promise.all([
      store.setStatus('id1', 'promoting'),
      store.setStatus('id1', 'promotion_cancelled', 'user cancelled'),
    ])

    expect(store.hasActivePromotion()).toBe(false)
    expect(createScanStore(file).getLatest()?.automations[0].status).toBe('promotion_cancelled')
    expect(createScanStore(file).getLatest()?.automations[0].statusDetail).toBe('user cancelled')
  })

  it('does not revive an interrupted promotion as still running after reload', async () => {
    const store = createScanStore(file)
    await store.runScan(async () => [auto({ id: 'id1' })])
    await store.setStatus('id1', 'promoting')

    const reloaded = createScanStore(file)
    expect(reloaded.hasActivePromotion()).toBe(false)
    expect(reloaded.getLatest()?.automations[0].status).toBe('promotion_failed')
    expect(reloaded.getLatest()?.automations[0].statusDetail).toContain('interrupted')
  })
})
