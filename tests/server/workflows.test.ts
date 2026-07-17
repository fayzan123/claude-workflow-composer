import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../../src/server/index.js'
import { replaceWorkflowFileAtomically } from '../../src/server/api/workflows.js'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import type { CwcFile } from '../../src/schema.js'

let server: http.Server
let tmpDir: string
let port: number
let runStore: RunStore

const FIXTURE_CWC: CwcFile = {
  meta: { id: 'test-uuid', name: 'Test Workflow', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [], edges: [],
}

function workflow(name: string, id: string): CwcFile {
  return {
    ...FIXTURE_CWC,
    meta: { ...FIXTURE_CWC.meta, id, name },
  }
}

async function fileRevision(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath, 'utf-8')).digest('hex')
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-test-'))
  const recentsPath = path.join(tmpDir, 'recents.json')
  const runsDir = path.join(tmpDir, 'runs')
  runStore = createRunStore(runsDir)
  const app = createApp({ staticDir: null, workflowsDir: tmpDir, recentsPath, runsDir, runStore })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpDir, { recursive: true })
})

async function httpGet(urlPath: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    }).on('error', reject)
  })
}

async function httpPost(urlPath: string, body: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.write(payload); req.end()
  })
}

async function httpRename(
  body: { oldPath: string; newName: string; workflowId?: string },
  expectedRevision?: string,
) {
  let revision = expectedRevision
  if (!revision) {
    try { revision = await fileRevision(body.oldPath) } catch { revision = '0'.repeat(64) }
  }
  return httpPost('/api/workflows/rename', { ...body, expectedRevision: revision })
}

async function httpDelete(urlPath: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'DELETE' }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.end()
  })
}

it('POST /api/workflows saves a .cwc file', async () => {
  const filePath = path.join(tmpDir, 'test.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpPost('/api/workflows', {
    path: filePath,
    content: FIXTURE_CWC,
    expectedRevision: await fileRevision(filePath),
  })
  expect(status).toBe(200)
  expect((body as { saved: boolean }).saved).toBe(true)
  const raw = await fs.readFile(filePath, 'utf-8')
  expect(JSON.parse(raw).meta.name).toBe('Test Workflow')
})

it('POST /api/workflows updates an existing recipe with the same identity', async () => {
  const filePath = path.join(tmpDir, 'update-existing.cwc')
  await fs.writeFile(filePath, JSON.stringify(workflow('Before Update', 'same-id')), 'utf-8')

  const { status } = await httpPost('/api/workflows', {
    path: filePath,
    content: workflow('After Update', 'same-id'),
    expectedRevision: await fileRevision(filePath),
  })

  expect(status).toBe(200)
  const saved = JSON.parse(await fs.readFile(filePath, 'utf-8')) as CwcFile
  expect(saved.meta).toMatchObject({ id: 'same-id', name: 'After Update' })
})

it('POST /api/workflows refuses to replace a different recipe at the same path', async () => {
  const filePath = path.join(tmpDir, 'identity-mismatch.cwc')
  const original = workflow('Original Recipe', 'original-id')
  await fs.writeFile(filePath, JSON.stringify(original), 'utf-8')

  const { status, body } = await httpPost('/api/workflows', {
    path: filePath,
    content: workflow('Stale Editor', 'stale-id'),
    expectedRevision: await fileRevision(filePath),
  })

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/identity does not match/i)
  expect(JSON.parse(await fs.readFile(filePath, 'utf-8'))).toEqual(original)
})

it('POST /api/workflows cannot recreate a recipe deleted by another editor', async () => {
  const filePath = path.join(tmpDir, 'stale-after-delete.cwc')
  const content = workflow('Delete Me', 'deleted-id')
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')
  const expectedRevision = await fileRevision(filePath)
  expect((await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)).status).toBe(200)

  const { status, body } = await httpPost('/api/workflows', { path: filePath, content, expectedRevision })

  expect(status).toBe(404)
  expect((body as { error: string }).error).toMatch(/no longer exists/i)
  await expect(fs.access(filePath)).rejects.toThrow()
})

it('an atomic update failure preserves the complete original recipe', async () => {
  const filePath = path.join(tmpDir, 'failed-atomic-update.cwc')
  const original = workflow('Before Failure', 'atomic-id')
  await fs.writeFile(filePath, JSON.stringify(original, null, 2), 'utf-8')
  const mode = (await fs.stat(filePath)).mode

  await expect(replaceWorkflowFileAtomically(
    filePath,
    workflow('After Failure', 'atomic-id'),
    mode,
    { beforeCommit: async () => { throw new Error('injected commit failure') } },
  )).rejects.toThrow('injected commit failure')

  expect(JSON.parse(await fs.readFile(filePath, 'utf-8'))).toEqual(original)
  expect((await fs.readdir(tmpDir)).filter(name => name.includes('failed-atomic-update.cwc.') && name.endsWith('.tmp'))).toEqual([])
})

it('an external edit racing an atomic workflow update is preserved', async () => {
  const filePath = path.join(tmpDir, 'external-edit-race.cwc')
  const original = workflow('Before External Edit', 'external-edit-id')
  await fs.writeFile(filePath, JSON.stringify(original), 'utf-8')
  const expectedRevision = await fileRevision(filePath)
  const external = workflow('Saved By Another Editor', 'external-edit-id')

  await expect(replaceWorkflowFileAtomically(
    filePath,
    workflow('Stale Replacement', 'external-edit-id'),
    (await fs.stat(filePath)).mode,
    {
      expectedRevision,
      beforeCommit: async () => { await fs.writeFile(filePath, JSON.stringify(external), 'utf-8') },
    },
  )).rejects.toThrow(/changed/i)

  expect(JSON.parse(await fs.readFile(filePath, 'utf-8'))).toEqual(external)
})

it('POST /api/workflows rejects a stale same-identity editor revision', async () => {
  const filePath = path.join(tmpDir, 'same-id-stale-editor.cwc')
  const original = workflow('Shared Recipe', 'shared-editor-id')
  await fs.writeFile(filePath, JSON.stringify(original), 'utf-8')
  const sharedRevision = await fileRevision(filePath)
  const firstEdit = { ...original, meta: { ...original.meta, description: 'first editor won' } }
  const staleEdit = { ...original, meta: { ...original.meta, description: 'stale editor overwrite' } }

  const first = await httpPost('/api/workflows', {
    path: filePath,
    content: firstEdit,
    expectedRevision: sharedRevision,
  })
  const stale = await httpPost('/api/workflows', {
    path: filePath,
    content: staleEdit,
    expectedRevision: sharedRevision,
  })

  expect(first.status).toBe(200)
  expect((first.body as { revision: string }).revision).toMatch(/^[0-9a-f]{64}$/)
  expect(stale.status).toBe(409)
  expect((stale.body as { error: string }).error).toMatch(/another editor/i)
  expect((JSON.parse(await fs.readFile(filePath, 'utf-8')) as CwcFile).meta.description).toBe('first editor won')
})

it('GET /api/workflows/default-path returns the first available deterministic suffix', async () => {
  await fs.writeFile(path.join(tmpDir, 'repeated-workflow.cwc'), '{}', 'utf-8')
  await fs.writeFile(path.join(tmpDir, 'repeated-workflow-2.cwc'), '{}', 'utf-8')

  const { status, body } = await httpGet('/api/workflows/default-path?name=Repeated%20Workflow')

  expect(status).toBe(200)
  expect((body as { path: string }).path).toBe(path.join(tmpDir, 'repeated-workflow-3.cwc'))
})

it('POST /api/workflows/create never overwrites another workflow with the same name', async () => {
  const originalPath = path.join(tmpDir, 'duplicate-template.cwc')
  await fs.writeFile(originalPath, JSON.stringify(workflow('Duplicate Template', 'original')), 'utf-8')

  const first = await httpPost('/api/workflows/create', {
    content: workflow('Duplicate Template', 'copy-1'),
  })
  const second = await httpPost('/api/workflows/create', {
    content: workflow('Duplicate Template', 'copy-2'),
  })

  expect(first.status).toBe(201)
  expect(second.status).toBe(201)
  expect((first.body as { path: string }).path).toBe(path.join(tmpDir, 'duplicate-template-2.cwc'))
  expect((second.body as { path: string }).path).toBe(path.join(tmpDir, 'duplicate-template-3.cwc'))

  const original = JSON.parse(await fs.readFile(originalPath, 'utf-8')) as CwcFile
  const copy1 = JSON.parse(await fs.readFile(path.join(tmpDir, 'duplicate-template-2.cwc'), 'utf-8')) as CwcFile
  const copy2 = JSON.parse(await fs.readFile(path.join(tmpDir, 'duplicate-template-3.cwc'), 'utf-8')) as CwcFile
  expect(original.meta.id).toBe('original')
  expect(copy1.meta.id).toBe('copy-1')
  expect(copy2.meta.id).toBe('copy-2')
})

it('POST /api/workflows/create allocates unique files under concurrent requests', async () => {
  const count = 8
  const responses = await Promise.all(
    Array.from({ length: count }, (_, i) => httpPost('/api/workflows/create', {
      content: workflow('Concurrent Workflow', `concurrent-${i}`),
    })),
  )

  expect(responses.every(response => response.status === 201)).toBe(true)
  const paths = responses.map(response => (response.body as { path: string }).path)
  expect(new Set(paths).size).toBe(count)
  expect(paths.map(filePath => path.basename(filePath)).sort()).toEqual(
    Array.from({ length: count }, (_, i) => `concurrent-workflow${i === 0 ? '' : `-${i + 1}`}.cwc`).sort(),
  )

  const savedIds = await Promise.all(paths.map(async filePath => {
    const saved = JSON.parse(await fs.readFile(filePath, 'utf-8')) as CwcFile
    return saved.meta.id
  }))
  expect(savedIds.sort()).toEqual(Array.from({ length: count }, (_, i) => `concurrent-${i}`).sort())
})

it('GET /api/workflows?path reads a saved .cwc file', async () => {
  const filePath = path.join(tmpDir, 'test.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpGet(`/api/workflows?path=${encodeURIComponent(filePath)}`)
  expect(status).toBe(200)
  expect((body as CwcFile).meta.id).toBe('test-uuid')
})

it('GET /api/workflows/list returns .cwc files in workflowsDir', async () => {
  const filePath = path.join(tmpDir, 'listed.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpGet('/api/workflows/list')
  expect(status).toBe(200)
  const items = body as { path: string; name: string }[]
  expect(items.some((i) => i.path === filePath && i.name === 'Test Workflow')).toBe(true)
})

it('GET /api/workflows/list includes nodeCount', async () => {
  const filePath = path.join(tmpDir, 'counted.cwc')
  const cwc: CwcFile = {
    ...FIXTURE_CWC,
    nodes: [
      { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'A', description: '', completionCriteria: '' } },
      { id: 'n2', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'B', description: '', completionCriteria: '' } },
    ],
  }
  await fs.writeFile(filePath, JSON.stringify(cwc), 'utf-8')
  const { status, body } = await httpGet('/api/workflows/list')
  expect(status).toBe(200)
  const items = body as { path: string; nodeCount: number }[]
  const item = items.find((i) => i.path === filePath)
  expect(item?.nodeCount).toBe(2)
})

it('GET /api/workflows?path returns 404 for missing file', async () => {
  const { status } = await httpGet(`/api/workflows?path=${encodeURIComponent(path.join(tmpDir, 'does-not-exist.cwc'))}`)
  expect(status).toBe(404)
})

it('GET /api/workflows?path returns 403 outside workflowsDir', async () => {
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.cwc`)
  const { status } = await httpGet(`/api/workflows?path=${encodeURIComponent(outside)}`)
  expect(status).toBe(403)
})

it('POST /api/workflows rejects writes outside workflowsDir', async () => {
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.cwc`)
  const { status } = await httpPost('/api/workflows', { path: outside, content: FIXTURE_CWC })
  expect(status).toBe(403)
})

it('DELETE /api/workflows rejects deletes outside workflowsDir', async () => {
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.cwc`)
  await fs.writeFile(outside, JSON.stringify(FIXTURE_CWC), 'utf-8')
  try {
    const { status } = await httpDelete(`/api/workflows?path=${encodeURIComponent(outside)}`)
    expect(status).toBe(403)
    await expect(fs.access(outside)).resolves.toBeUndefined()
  } finally {
    await fs.unlink(outside).catch(() => {})
  }
})

it('DELETE /api/workflows deletes the file', async () => {
  const filePath = path.join(tmpDir, 'to-delete.cwc')
  await fs.writeFile(filePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)
  expect(status).toBe(200)
  expect((body as { deleted: boolean }).deleted).toBe(true)
  await expect(fs.access(filePath)).rejects.toThrow()
})

it('DELETE /api/workflows refuses a stale recipe identity', async () => {
  const filePath = path.join(tmpDir, 'delete-identity-mismatch.cwc')
  const content = workflow('Current Delete Target', 'current-delete-id')
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')

  const { status, body } = await httpDelete(
    `/api/workflows?path=${encodeURIComponent(filePath)}&workflowId=${encodeURIComponent('stale-delete-id')}`,
  )

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/identity does not match/i)
  await expect(fs.access(filePath)).resolves.toBeUndefined()
})

it('DELETE /api/workflows preserves a workflow with an active managed run', async () => {
  const filePath = path.join(tmpDir, 'active-run.cwc')
  const content = workflow('Active Run', 'wf-active-delete')
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')
  runStore.registerRun('run-active-delete', content.meta.id, () => {})
  try {
    const { status, body } = await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)
    expect(status).toBe(409)
    expect((body as { error: string }).error).toMatch(/stop the active run/i)
    await expect(fs.access(filePath)).resolves.toBeUndefined()
  } finally {
    runStore.releaseRun('run-active-delete')
  }
})

it('DELETE /api/workflows preserves a workflow with a paused run', async () => {
  const filePath = path.join(tmpDir, 'paused-run.cwc')
  const content = workflow('Paused Run', 'wf-paused-delete')
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')
  const startedAt = new Date().toISOString()
  await runStore.append({
    runId: 'run-paused-delete', workflowId: content.meta.id, workflowSlug: 'cwc-paused-run',
    type: 'run_started', ts: startedAt, source: 'test',
  })
  await runStore.append({
    runId: 'run-paused-delete', workflowId: content.meta.id, workflowSlug: 'cwc-paused-run',
    type: 'run_paused', ts: new Date().toISOString(), source: 'test', sessionId: 'session-paused',
  })

  const { status, body } = await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)
  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/approve or reject/i)
  await expect(fs.access(filePath)).resolves.toBeUndefined()
})

it('DELETE /api/workflows trusts a paused manifest even when observational events are missing', async () => {
  const filePath = path.join(tmpDir, 'manifest-only-paused.cwc')
  const content = workflow('Manifest Only Paused', 'wf-manifest-only-paused')
  await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')
  await runStore.manifests.create({
    runId: 'run-manifest-only-paused',
    workflowId: content.meta.id,
    workflowSkillSlug: 'cwc-manifest-only-paused',
    triggerId: 'manual',
    requestedIsolation: 'in-place',
    originalCwd: tmpDir,
    requestedBaseRef: 'HEAD',
  })
  await runStore.manifests.transition(content.meta.id, 'run-manifest-only-paused', manifest => ({
    ...manifest,
    lifecycleState: 'paused',
    sessionId: 'session-manifest-only-paused',
  }))

  const { status, body } = await httpDelete(`/api/workflows?path=${encodeURIComponent(filePath)}`)

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/approve or reject/i)
  await expect(fs.access(filePath)).resolves.toBeUndefined()
  await expect(runStore.getEvents(content.meta.id, 'run-manifest-only-paused')).resolves.toBeNull()
})

it('POST /api/workflows/rename renames the file and returns new path', async () => {
  const oldPath = path.join(tmpDir, 'rename-me.cwc')
  await fs.writeFile(oldPath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpRename({ oldPath, newName: 'Brand New Name' })
  expect(status).toBe(200)
  const result = body as { path: string; renamed: boolean; revision: string; content: CwcFile }
  expect(result.renamed).toBe(true)
  expect(result.path).toContain('brand-new-name.cwc')
  await expect(fs.access(oldPath)).rejects.toThrow()
  const raw = await fs.readFile(result.path, 'utf-8')
  expect(JSON.parse(raw).meta.name).toBe('Brand New Name')
  expect(result.content).toEqual(JSON.parse(raw))
  expect(result.revision).toBe(createHash('sha256').update(raw).digest('hex'))
})

it('POST /api/workflows/rename still moves the file when autosave already persisted the new display name', async () => {
  const oldPath = path.join(tmpDir, 'old-display-name.cwc')
  const alreadySaved = { ...FIXTURE_CWC, meta: { ...FIXTURE_CWC.meta, name: 'Already Saved Name' } }
  await fs.writeFile(oldPath, JSON.stringify(alreadySaved), 'utf-8')

  const { status, body } = await httpRename({ oldPath, newName: 'Already Saved Name' })

  expect(status).toBe(200)
  const result = body as { path: string; renamed: boolean }
  expect(result.renamed).toBe(true)
  expect(result.path).toBe(path.join(tmpDir, 'already-saved-name.cwc'))
  await expect(fs.access(oldPath)).rejects.toThrow()
  await expect(fs.access(result.path)).resolves.toBeUndefined()
})

it('POST /api/workflows/rename keeps a plain skill node identity synchronized', async () => {
  const oldPath = path.join(tmpDir, 'old-skill.cwc')
  const cwc: CwcFile = {
    meta: {
      ...FIXTURE_CWC.meta,
      id: 'rename-skill',
      name: 'Old Skill',
      artifactKind: 'skill',
      artifactTier: 'skill',
    },
    nodes: [{
      id: 'skill-node',
      position: { x: 0, y: 0 },
      exportedSlug: null,
      agent: { name: 'Old Skill', description: 'Use when testing rename.', completionCriteria: '', systemPrompt: '# Old skill' },
    }],
    edges: [],
  }
  await fs.writeFile(oldPath, JSON.stringify(cwc), 'utf-8')

  const { status, body } = await httpRename({ oldPath, newName: 'New Skill' })
  expect(status).toBe(200)
  const saved = JSON.parse(await fs.readFile((body as { path: string }).path, 'utf-8')) as CwcFile
  expect(saved.meta.name).toBe('New Skill')
  expect(saved.nodes[0].agent.name).toBe('New Skill')
})

it('serializes a concurrent save and rename without losing an acknowledged save', async () => {
  const oldPath = path.join(tmpDir, 'save-rename-race.cwc')
  const destinationPath = path.join(tmpDir, 'save-rename-result.cwc')
  const original = workflow('Save Rename Race', 'save-rename-id')
  const updated: CwcFile = {
    ...original,
    meta: { ...original.meta, description: 'content acknowledged by save' },
  }
  await fs.writeFile(oldPath, JSON.stringify(original), 'utf-8')
  const sharedRevision = await fileRevision(oldPath)

  const [saveResult, renameResult] = await Promise.all([
    httpPost('/api/workflows', {
      path: oldPath,
      content: updated,
      expectedRevision: sharedRevision,
    }),
    httpRename({
      oldPath,
      newName: 'Save Rename Result',
      workflowId: original.meta.id,
    }, sharedRevision),
  ])

  expect([saveResult.status, renameResult.status].filter(status => status === 200)).toHaveLength(1)
  if (saveResult.status === 200) {
    expect(renameResult.status).toBe(409)
    await expect(fs.access(destinationPath)).rejects.toThrow()
    const persisted = JSON.parse(await fs.readFile(oldPath, 'utf-8')) as CwcFile
    expect(persisted.meta.description).toBe('content acknowledged by save')
  } else {
    expect(saveResult.status).toBe(404)
    expect(renameResult.status).toBe(200)
    await expect(fs.access(oldPath)).rejects.toThrow()
    const persisted = JSON.parse(await fs.readFile(destinationPath, 'utf-8')) as CwcFile
    expect(persisted.meta.description).toBe(original.meta.description)
  }
})

it('serializes a concurrent delete and rename without recreating a deleted recipe', async () => {
  const oldPath = path.join(tmpDir, 'delete-rename-race.cwc')
  const destinationPath = path.join(tmpDir, 'delete-rename-result.cwc')
  const original = workflow('Delete Rename Race', 'delete-rename-id')
  await fs.writeFile(oldPath, JSON.stringify(original), 'utf-8')
  const sharedRevision = await fileRevision(oldPath)

  const [deleteResult, renameResult] = await Promise.all([
    httpDelete(`/api/workflows?path=${encodeURIComponent(oldPath)}&workflowId=${encodeURIComponent(original.meta.id)}`),
    httpRename({
      oldPath,
      newName: 'Delete Rename Result',
      workflowId: original.meta.id,
    }, sharedRevision),
  ])

  expect([deleteResult.status, renameResult.status].sort()).toEqual([200, 404])
  await expect(fs.access(oldPath)).rejects.toThrow()
  if (deleteResult.status === 200) {
    await expect(fs.access(destinationPath)).rejects.toThrow()
  } else {
    const persisted = JSON.parse(await fs.readFile(destinationPath, 'utf-8')) as CwcFile
    expect(persisted.meta.id).toBe(original.meta.id)
  }
})

it('POST /api/workflows/rename atomically rejects concurrent destination collisions', async () => {
  const firstPath = path.join(tmpDir, 'rename-race-a.cwc')
  const secondPath = path.join(tmpDir, 'rename-race-b.cwc')
  await fs.writeFile(firstPath, JSON.stringify(workflow('Race A', 'race-a')), 'utf-8')
  await fs.writeFile(secondPath, JSON.stringify(workflow('Race B', 'race-b')), 'utf-8')

  const results = await Promise.all([
    httpRename({ oldPath: firstPath, newName: 'Shared Destination' }),
    httpRename({ oldPath: secondPath, newName: 'Shared Destination' }),
  ])

  expect(results.map(result => result.status).sort()).toEqual([200, 400])
  const destination = JSON.parse(await fs.readFile(path.join(tmpDir, 'shared-destination.cwc'), 'utf-8')) as CwcFile
  expect(['race-a', 'race-b']).toContain(destination.meta.id)
  const losingPath = destination.meta.id === 'race-a' ? secondPath : firstPath
  await expect(fs.access(losingPath)).resolves.toBeUndefined()
})

it('POST /api/workflows/rename returns renamed:false when slug is unchanged', async () => {
  const filePath = path.join(tmpDir, 'same-slug.cwc')
  await fs.writeFile(filePath, JSON.stringify({ ...FIXTURE_CWC, meta: { ...FIXTURE_CWC.meta, name: 'Same Slug' } }), 'utf-8')
  const { status, body } = await httpRename({ oldPath: filePath, newName: 'Same Slug' })
  expect(status).toBe(200)
  expect((body as { renamed: boolean }).renamed).toBe(false)
  await expect(fs.access(filePath)).resolves.toBeUndefined()
})

it('POST /api/workflows/rename persists a display-name change when the filename slug is unchanged', async () => {
  const filePath = path.join(tmpDir, 'same-slug-display.cwc')
  await fs.writeFile(filePath, JSON.stringify({
    ...FIXTURE_CWC,
    meta: { ...FIXTURE_CWC.meta, name: 'same slug display' },
  }), 'utf-8')

  const { status, body } = await httpRename({ oldPath: filePath, newName: 'Same Slug Display' })
  expect(status).toBe(200)
  expect(body).toMatchObject({ path: filePath, renamed: false })
  expect((body as { revision: string }).revision).toMatch(/^[0-9a-f]{64}$/)
  const saved = JSON.parse(await fs.readFile(filePath, 'utf-8')) as CwcFile
  expect(saved.meta.name).toBe('Same Slug Display')
})

it('POST /api/workflows/rename leaves a suffixed duplicate in place when its name is unchanged', async () => {
  const basePath = path.join(tmpDir, 'same-display-name.cwc')
  const duplicatePath = path.join(tmpDir, 'same-display-name-2.cwc')
  await fs.writeFile(basePath, JSON.stringify(workflow('Same Display Name', 'base')), 'utf-8')
  await fs.writeFile(duplicatePath, JSON.stringify(workflow('Same Display Name', 'duplicate')), 'utf-8')

  const { status, body } = await httpRename({
    oldPath: duplicatePath,
    newName: 'Same Display Name',
  })

  expect(status).toBe(200)
  expect(body).toMatchObject({ path: duplicatePath, renamed: false })
  expect((body as { revision: string }).revision).toMatch(/^[0-9a-f]{64}$/)
  await expect(fs.access(basePath)).resolves.toBeUndefined()
  await expect(fs.access(duplicatePath)).resolves.toBeUndefined()
})

it('POST /api/workflows/rename returns 400 when target name already exists', async () => {
  const existingPath = path.join(tmpDir, 'already-exists.cwc')
  const sourcePath = path.join(tmpDir, 'source-wf.cwc')
  await fs.writeFile(existingPath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  await fs.writeFile(sourcePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status } = await httpRename({ oldPath: sourcePath, newName: 'Already Exists' })
  expect(status).toBe(400)
})

it('POST /api/workflows/rename refuses a stale recipe identity', async () => {
  const sourcePath = path.join(tmpDir, 'rename-identity-mismatch.cwc')
  const destinationPath = path.join(tmpDir, 'should-not-be-renamed.cwc')
  await fs.writeFile(sourcePath, JSON.stringify(workflow('Current Rename Target', 'current-rename-id')), 'utf-8')

  const { status, body } = await httpRename({
    oldPath: sourcePath,
    newName: 'Should Not Be Renamed',
    workflowId: 'stale-rename-id',
  })

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/identity does not match/i)
  await expect(fs.access(sourcePath)).resolves.toBeUndefined()
  await expect(fs.access(destinationPath)).rejects.toThrow()
})

it('POST /api/workflows/rename requires explicit recipe revision authority', async () => {
  const sourcePath = path.join(tmpDir, 'rename-without-revision.cwc')
  const content = workflow('Rename Without Revision', 'rename-without-revision-id')
  await fs.writeFile(sourcePath, JSON.stringify(content), 'utf-8')

  const { status, body } = await httpPost('/api/workflows/rename', {
    oldPath: sourcePath,
    newName: 'Must Not Move',
    workflowId: content.meta.id,
  })

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/revision required/i)
  await expect(fs.access(sourcePath)).resolves.toBeUndefined()
  await expect(fs.access(path.join(tmpDir, 'must-not-move.cwc'))).rejects.toThrow()
})

it('POST /api/workflows/rename rejects a stale revision after a newer save', async () => {
  const sourcePath = path.join(tmpDir, 'stale-rename-revision.cwc')
  const destinationPath = path.join(tmpDir, 'stale-rename-must-not-win.cwc')
  const original = workflow('Stale Rename Revision', 'stale-rename-revision-id')
  const newer: CwcFile = {
    ...original,
    meta: { ...original.meta, description: 'newer editor content' },
  }
  await fs.writeFile(sourcePath, JSON.stringify(original), 'utf-8')
  const staleRevision = await fileRevision(sourcePath)
  expect((await httpPost('/api/workflows', {
    path: sourcePath,
    content: newer,
    expectedRevision: staleRevision,
  })).status).toBe(200)

  const { status, body } = await httpRename({
    oldPath: sourcePath,
    newName: 'Stale Rename Must Not Win',
    workflowId: original.meta.id,
  }, staleRevision)

  expect(status).toBe(409)
  expect((body as { error: string }).error).toMatch(/another editor/i)
  expect((JSON.parse(await fs.readFile(sourcePath, 'utf-8')) as CwcFile).meta.description).toBe('newer editor content')
  await expect(fs.access(destinationPath)).rejects.toThrow()
})

it('POST /api/workflows/rename returns 404 when source file is missing', async () => {
  const { status } = await httpRename({
    oldPath: path.join(tmpDir, 'ghost.cwc'),
    newName: 'New Name',
  })
  expect(status).toBe(404)
})

it('POST /api/workflows/rename rejects sources outside workflowsDir', async () => {
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.cwc`)
  const { status } = await httpRename({ oldPath: outside, newName: 'New Name' })
  expect(status).toBe(403)
})
