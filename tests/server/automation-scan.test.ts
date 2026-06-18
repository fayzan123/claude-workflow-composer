import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let home: string, scanPath: string, server: http.Server, base: string

const cannedRunner = async () => ({
  result: JSON.stringify({ automations: [{
    title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
    stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
    suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9,
  }] }), sessionId: 's',
})

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-scanapi-'))
  scanPath = path.join(home, 'scan.json')
  const proj = path.join(home, '.claude', 'projects', 'p1')
  await fs.mkdir(proj, { recursive: true })
  const L = (o: unknown) => JSON.stringify(o) + '\n'
  const push = (ts: string) => L({ type: 'user', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } })
    + L({ type: 'assistant', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test && git push' } }] } })
  await fs.writeFile(path.join(proj, 'S.jsonl'), push('2026-06-01T10:00:00Z') + push('2026-06-02T10:00:00Z') + push('2026-06-03T10:00:00Z'))
  const app = createApp({ staticDir: null, userHomeDir: home, automationScanPath: scanPath, claudeRunner: cannedRunner, enableNotifier: false })
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

    const id = done.automations[0].id
    const dis = await fetch(`${base}/api/automation-scan/${id}/dismiss`, { method: 'POST' })
    expect(dis.status).toBe(200)
    const after = await (await fetch(`${base}/api/automation-scan`)).json() as { automations: { status: string }[] }
    expect(after.automations[0].status).toBe('dismissed')
  })
})
