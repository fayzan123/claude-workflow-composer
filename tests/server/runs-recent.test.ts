import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let runsDir: string, server: http.Server, base: string
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-recent-'))
  for (const [wf, ts] of [['wf-1', '2026-06-10T00:00:00Z'], ['wf-2', '2026-06-12T00:00:00Z']] as const) {
    const d = path.join(runsDir, wf); await fs.mkdir(d, { recursive: true })
    const line = JSON.stringify({ runId: `r-${wf}`, workflowId: wf, workflowSlug: `cwc-${wf}`, type: 'run_started', ts, source: 'test', cwd: '/tmp' })
    await fs.writeFile(path.join(d, `r-${wf}.jsonl`), line + '\n')
  }
  const app = createApp({ staticDir: null, runsDir, enableNotifier: false })
  server = app.listen(0); base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.close(); await fs.rm(runsDir, { recursive: true, force: true }) })

it('GET /runs/recent returns runs across workflows, newest first', async () => {
  const runs = await (await fetch(`${base}/api/runs/recent?limit=10`)).json() as Array<{ workflowId: string }>
  expect(runs.length).toBe(2)
  expect(runs[0].workflowId).toBe('wf-2')
})
