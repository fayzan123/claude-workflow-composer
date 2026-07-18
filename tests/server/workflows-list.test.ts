import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'

let dir: string, server: http.Server, base: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-wflist-'))
  const workflowPath = path.join(dir, 'a.cwc')
  await fs.writeFile(workflowPath, JSON.stringify({
    meta: { id: 'wf-abc', name: 'Alpha', description: '', version: 1, created: '', updated: '2026-06-18T00:00:00.000Z' },
    nodes: [], edges: [],
  }))
  const mtime = new Date('2026-06-18T20:00:00.000Z')
  await fs.utimes(workflowPath, mtime, mtime)
  const app = createApp({ staticDir: null, workflowsDir: dir, enableNotifier: false })
  server = app.listen(0); base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }) })

it('GET /workflows/list includes meta.id', async () => {
  const items = await (await fetch(`${base}/api/workflows/list`)).json() as Array<{ id: string; name: string; artifactKind: string; artifactTier: string }>
  const alpha = items.find(i => i.name === 'Alpha')
  expect(alpha?.id).toBe('wf-abc')
  expect(alpha?.artifactKind).toBe('workflow')
  expect(alpha?.artifactTier).toBe('workflow')
})

it('GET /workflows/list uses file mtime when embedded metadata is stale', async () => {
  const items = await (await fetch(`${base}/api/workflows/list`)).json() as Array<{ id: string; name: string; updated: string }>
  const alpha = items.find(i => i.name === 'Alpha')
  expect(alpha?.updated).toBe('2026-06-18T20:00:00.000Z')
})

it('GET /workflows/list exposes persisted skill and loop identity', async () => {
  await fs.writeFile(path.join(dir, 'cleanup.cwc'), JSON.stringify({
    meta: {
      id: 'skill-1', name: 'Cleanup', description: '', version: 2, created: '', updated: '',
      artifactKind: 'skill', artifactTier: 'loop',
    },
    nodes: [{
      id: 'node-1', position: { x: 0, y: 0 }, exportedSlug: null,
      agent: { name: 'Cleanup', description: 'Use when cleaning up.', completionCriteria: '', systemPrompt: '# Cleanup\n\nDo it.' },
    }],
    edges: [],
  }))

  const items = await (await fetch(`${base}/api/workflows/list`)).json() as Array<{ id: string; artifactKind: string; artifactTier: string }>
  expect(items.find(item => item.id === 'skill-1')).toMatchObject({ artifactKind: 'skill', artifactTier: 'loop' })
})
