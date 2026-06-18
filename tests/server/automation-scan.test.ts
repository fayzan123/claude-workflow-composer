import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'
import type { StreamingRunner } from '../../src/server/streaming-analyzer.js'

const fakeStreaming: StreamingRunner = async (_prompt, { onLog }) => {
  onLog({ level: 'info', message: 'session started' })
  onLog({ level: 'claude', message: 'clustering recurring tasks' })
  return { resultText: JSON.stringify({ automations: [{
    title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
    stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
    suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9,
  }] }), costUsd: 0.01 }
}

let home: string, scanPath: string, wfDir: string, server: http.Server, base: string

const cannedRunner = async () => ({
  result: JSON.stringify({ automations: [{
    title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
    stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
    suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9,
  }] }), sessionId: 's',
})

const smartRunner = async (prompt: string) => {
  if (prompt.includes('.cwc') || prompt.includes('"nodes"')) {
    return { result: JSON.stringify({
      meta: { id: 'wf-1', name: 'Tests And Push', description: 'd', version: 1, created: '2026-06-17T00:00:00Z', updated: '2026-06-17T00:00:00Z' },
      nodes: [{ id: 'n1', position: { x: 100, y: 300 }, exportedSlug: null, agent: { name: 'Runner', description: 'd', completionCriteria: 'c' } }],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'done', terminalType: 'complete' }],
    }), sessionId: 's' }
  }
  return cannedRunner()
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-scanapi-'))
  scanPath = path.join(home, 'scan.json')
  wfDir = path.join(home, 'workflows')
  const proj = path.join(home, '.claude', 'projects', 'p1')
  await fs.mkdir(proj, { recursive: true })
  const L = (o: unknown) => JSON.stringify(o) + '\n'
  const push = (ts: string) => L({ type: 'user', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } })
    + L({ type: 'assistant', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test && git push' } }] } })
  await fs.writeFile(path.join(proj, 'S.jsonl'), push('2026-06-01T10:00:00Z') + push('2026-06-02T10:00:00Z') + push('2026-06-03T10:00:00Z'))
  const app = createApp({ staticDir: null, userHomeDir: home, automationScanPath: scanPath, workflowsDir: wfDir, claudeRunner: smartRunner, streamingRunner: fakeStreaming, enableNotifier: false })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.close(); await fs.rm(home, { recursive: true, force: true }) })

async function waitForDone(): Promise<{ automations: { id: string; title: string; status: string }[] }> {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`${base}/api/automation-scan`)).json() as { status?: string }
    if (r.status === 'done' || r.status === 'error') return r as never
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error('scan did not finish')
}

describe('automation-scan API', () => {
  it('runs a scan and returns detected automations, then dismiss persists', async () => {
    const start = await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    expect(start.status).toBe(202)
    const done = await waitForDone()
    expect(done.automations).toHaveLength(1)
    expect(done.automations[0].title).toBe('Run tests then push')
    // NEW: the streamed log is buffered and returned
    const withLog = await (await fetch(`${base}/api/automation-scan`)).json() as { log: { level: string; message: string }[] }
    expect(withLog.log.some(l => l.message === 'clustering recurring tasks')).toBe(true)
    expect(withLog.log.some(l => l.level === 'info' && /digest lines|task units|transcript/i.test(l.message))).toBe(true)

    const id = done.automations[0].id
    const dis = await fetch(`${base}/api/automation-scan/${id}/dismiss`, { method: 'POST' })
    expect(dis.status).toBe(200)
    const after = await (await fetch(`${base}/api/automation-scan`)).json() as { automations: { status: string }[] }
    expect(after.automations[0].status).toBe('dismissed')
  })

  it('promote generates a .cwc with a disabled cron trigger and marks the candidate promoted', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    const done = await waitForDone()
    const id = done.automations[0].id

    const res = await fetch(`${base}/api/automation-scan/${id}/promote`, { method: 'POST' })
    expect(res.status).toBe(200)
    const { workflowId } = await res.json() as { workflowId: string }
    // Server assigns a fresh UUID — it must be a non-empty string, must NOT be the
    // LLM-generated 'wf-1', and must look like a UUID (contains hyphens).
    expect(typeof workflowId).toBe('string')
    expect(workflowId.length).toBeGreaterThan(0)
    expect(workflowId).not.toBe('wf-1')
    expect(workflowId).toMatch(/^[0-9a-f-]{36}$/)

    const files = await fs.readdir(wfDir)
    expect(files.some(f => f.endsWith('.cwc'))).toBe(true)
    const cwc = JSON.parse(await fs.readFile(path.join(wfDir, files[0]), 'utf-8'))
    // The written file must carry the server-assigned id (same as the returned workflowId)
    expect(cwc.meta.id).toBe(workflowId)
    expect(cwc.meta.triggers[0].type).toBe('cron')
    expect(cwc.meta.triggers[0].enabled).toBe(false)

    const after = await (await fetch(`${base}/api/automation-scan`)).json() as { automations: { status: string }[] }
    expect(after.automations[0].status).toBe('promoted')
  })
})
