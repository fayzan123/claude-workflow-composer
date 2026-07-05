// tests/server/notifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import { startNotifier } from '../../src/server/notifier.js'
import { loadConfig, saveConfig } from '../../src/server/config.js'
import type { CwcConfig } from '../../src/server/config.js'

let tmpDir: string
let runsDir: string
let store: RunStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-notifier-'))
  runsDir = path.join(tmpDir, 'runs')
  await fs.mkdir(runsDir, { recursive: true })
  store = createRunStore(runsDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<CwcConfig['notifications']> = {}): CwcConfig {
  return { notifications: { macos: false, ...overrides } }
}

function baseEvent(type: string, extra: Record<string, unknown> = {}) {
  return {
    runId: 'run-1', workflowId: 'wf-1', workflowSlug: 'cwc-test',
    ts: new Date().toISOString(), source: 'test' as const,
    type, ...extra,
  }
}

describe('startNotifier', () => {
  it('run_paused always triggers macOS notify regardless of trigger', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape for test
      await store.append(baseEvent('run_paused', { workflowSlug: 'cwc-test' }))
      expect(captured).toHaveLength(1)
      expect(captured[0][0]).toContain('approval needed')
    } finally {
      unsub()
    }
  })

  it('awaiting_approval from an external run triggers a pause notification', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape for test
      await store.append(baseEvent('awaiting_approval', { source: 'external' }))
      expect(captured).toHaveLength(1)
      expect(captured[0][0]).toContain('approval needed')
    } finally {
      unsub()
    }
  })

  it('awaiting_approval followed by run_paused only notifies once for the same pause', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape for test
      await store.append(baseEvent('awaiting_approval', { source: 'test' }))
      // @ts-expect-error minimal event shape for test
      await store.append(baseEvent('run_paused', { source: 'test', sessionId: 's-1' }))
      expect(captured).toHaveLength(1)
    } finally {
      unsub()
    }
  })

  it('run_completed from automation (non-manual trigger) notifies', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_started', { trigger: 'trig-1' }))
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_completed', { status: 'complete', message: 'all done' }))
      expect(captured).toHaveLength(1)
      expect(captured[0][0]).toContain('cwc-test')
    } finally {
      unsub()
    }
  })

  it('run_completed from manual trigger does NOT notify', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_started', { trigger: 'manual' }))
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_completed', { status: 'complete' }))
      expect(captured).toHaveLength(0)
    } finally {
      unsub()
    }
  })

  it('run_completed with no known trigger (no run_started seen) does NOT notify', async () => {
    const captured: Array<[string, string]> = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => { captured.push([title, body]) },
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_completed', { status: 'complete' }))
      expect(captured).toHaveLength(0)
    } finally {
      unsub()
    }
  })

  it('webhook target receives event JSON', async () => {
    const received: unknown[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try { received.push(JSON.parse(body)) } catch { received.push(body) }
        res.writeHead(200)
        res.end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const webhookUrl = `http://127.0.0.1:${addr.port}`

    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: false, webhookUrl }),
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_started', { trigger: 'trig-1' }))
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_completed', { status: 'complete', message: 'done' }))
      // give the fetch a moment (fire-and-forget)
      await new Promise(r => setTimeout(r, 200))
      expect(received).toHaveLength(1)
      expect((received[0] as { type: string }).type).toBe('run_completed')
    } finally {
      unsub()
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('notifier survives webhook target being down (no throw)', async () => {
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: false, webhookUrl: 'http://127.0.0.1:1' }),
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_started', { trigger: 'trig-1' }))
      // @ts-expect-error minimal event shape
      await expect(store.append(baseEvent('run_completed', { status: 'complete' }))).resolves.toBeUndefined()
    } finally {
      unsub()
    }
  })

  it('macOS exec receives a display notification command (assert via captured args)', async () => {
    const capturedArgs: string[][] = []
    const unsub = startNotifier({
      store,
      getConfig: () => makeConfig({ macos: true }),
      execNotify: (title, body) => {
        // verify the arguments would form a valid osascript invocation
        capturedArgs.push(['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])
      },
    })
    try {
      // @ts-expect-error minimal event shape
      await store.append(baseEvent('run_paused', {}))
      expect(capturedArgs).toHaveLength(1)
      expect(capturedArgs[0][1]).toMatch(/^display notification/)
      expect(capturedArgs[0][1]).toContain('with title')
    } finally {
      unsub()
    }
  })
})

describe('loadConfig / saveConfig', () => {
  it('returns darwin default when file missing', async () => {
    const filePath = path.join(tmpDir, 'missing-config.json')
    const cfg = loadConfig(filePath)
    expect(cfg.notifications.macos).toBe(process.platform === 'darwin')
    expect(cfg.notifications.webhookUrl).toBeUndefined()
  })

  it('round-trips through saveConfig/loadConfig', async () => {
    const filePath = path.join(tmpDir, 'config.json')
    const original: CwcConfig = { notifications: { macos: false, webhookUrl: 'http://example.com/hook' } }
    await saveConfig(filePath, original)
    const loaded = loadConfig(filePath)
    expect(loaded).toEqual(original)
  })

  it('missing partial fields default gracefully', async () => {
    const filePath = path.join(tmpDir, 'partial-config.json')
    await fs.writeFile(filePath, JSON.stringify({ notifications: {} }))
    const cfg = loadConfig(filePath)
    expect(cfg.notifications.macos).toBe(process.platform === 'darwin')
  })
})
