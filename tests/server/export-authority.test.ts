import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../../src/server/index.js'
import { CWC_FILE_VERSION, type CwcFile } from '../../src/schema.js'
import { exportWorkflow } from '../../src/export/exporter.js'
import {
  createWorkflowMutationCoordinator,
  readPersistedWorkflow,
  replaceWorkflowFileAtomically,
  serializedWorkflow,
} from '../../src/server/api/workflows.js'
import { exportRouter } from '../../src/server/api/export.js'
import { exportDeleteRouter } from '../../src/server/api/export-delete.js'

let server: http.Server
let port: number
let tmpDir: string
let workflowsDir: string

function skillFixture(id: string, name: string): CwcFile {
  const now = '2026-07-16T00:00:00.000Z'
  return {
    meta: {
      id,
      name,
      description: `Prepare ${name.toLowerCase()}.`,
      version: CWC_FILE_VERSION,
      created: now,
      updated: now,
      artifactKind: 'skill',
      artifactTier: 'skill',
    },
    nodes: [{
      id: 'skill-node',
      position: { x: 0, y: 0 },
      exportedSlug: null,
      agent: {
        name,
        description: `Use when preparing ${name.toLowerCase()}.`,
        completionCriteria: '',
        systemPrompt: `# ${name}\n\n1. Read the inputs.\n2. Prepare the result.`,
      },
    }],
    edges: [],
  }
}

async function post<T>(urlPath: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://localhost:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as T }
}

async function createRecipe(content: CwcFile): Promise<{ path: string; revision: string }> {
  const result = await post<{ path: string; revision: string }>('/api/workflows/create', { content })
  expect(result.status).toBe(201)
  return result.body
}

function revision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function projectTarget(name: string) {
  return {
    target: { type: 'project' as const, projectDir: path.join(tmpDir, name) },
    skillPath: path.join(tmpDir, name, '.claude', 'skills'),
  }
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-export-authority-'))
  workflowsDir = path.join(tmpDir, 'workflows')
  const app = createApp({
    staticDir: null,
    workflowsDir,
    userHomeDir: path.join(tmpDir, 'home'),
    recentsPath: path.join(tmpDir, 'recents.json'),
    runsDir: path.join(tmpDir, 'runs'),
    worktreesRoot: path.join(tmpDir, 'worktrees'),
    automationStatePath: path.join(tmpDir, 'automation-state.json'),
    configPath: path.join(tmpDir, 'config.json'),
    automationScanPath: path.join(tmpDir, 'automation-scan.json'),
    enableNotifier: false,
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('export recipe authority', () => {
  it('requires current path and revision authority before export or deletion', async () => {
    const cwc = skillFixture('missing-authority', 'Missing Authority')
    const { target, skillPath } = projectTarget('missing-authority-project')

    const exported = await post<{ error: string }>('/api/export', { cwcFile: cwc, target })
    const deleted = await post<{ error: string }>('/api/export/delete', { cwcFile: cwc, target })

    expect(exported.status).toBe(409)
    expect(exported.body.error).toMatch(/path and revision are required/i)
    expect(deleted.status).toBe(409)
    expect(deleted.body.error).toMatch(/path and revision are required/i)
    await expect(fs.access(skillPath)).rejects.toThrow()
  })

  it('persists deployment identity in the same authorized export operation', async () => {
    const cwc = skillFixture('authorized-export', 'Authorized Export')
    const authority = await createRecipe(cwc)
    const { target, skillPath } = projectTarget('authorized-export-project')

    const result = await post<{
      updatedCwc: CwcFile
      recipeRevision: string
      artifactSlug: string
    }>('/api/export', {
      cwcFile: cwc,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })

    expect(result.status).toBe(200)
    expect(result.body.artifactSlug).toBe('authorized-export')
    expect(result.body.recipeRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(result.body.updatedCwc.meta.exportedWorkflowSlug).toBe('authorized-export')
    const rawRecipe = await fs.readFile(authority.path, 'utf-8')
    expect(JSON.parse(rawRecipe)).toEqual(result.body.updatedCwc)
    expect(revision(rawRecipe)).toBe(result.body.recipeRevision)
    await expect(fs.access(path.join(skillPath, 'authorized-export', 'SKILL.md'))).resolves.toBeUndefined()
  })

  it('rejects an export from a stale tab before touching its deployment target', async () => {
    const original = skillFixture('stale-export', 'Stale Export')
    const authority = await createRecipe(original)
    const newer: CwcFile = {
      ...original,
      meta: { ...original.meta, description: 'newer editor won' },
    }
    const saved = await post<{ revision: string }>('/api/workflows', {
      path: authority.path,
      content: newer,
      expectedRevision: authority.revision,
    })
    expect(saved.status).toBe(200)
    const { target, skillPath } = projectTarget('stale-export-project')

    const result = await post<{ error: string }>('/api/export', {
      cwcFile: original,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })

    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/another editor/i)
    expect((JSON.parse(await fs.readFile(authority.path, 'utf-8')) as CwcFile).meta.description).toBe('newer editor won')
    await expect(fs.access(path.join(skillPath, 'stale-export', 'SKILL.md'))).rejects.toThrow()
  })

  it('restores the prior deployment when the recipe CAS loses after deployment commit', async () => {
    const original = skillFixture('commit-race-export', 'Commit Race Export')
    const authority = await createRecipe(original)
    const { target, skillPath } = projectTarget('commit-race-export-project')
    const first = await post<{ updatedCwc: CwcFile; recipeRevision: string }>('/api/export', {
      cwcFile: original,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })
    expect(first.status).toBe(200)
    const deployedPath = path.join(skillPath, 'commit-race-export', 'SKILL.md')
    const priorDeployment = await fs.readFile(deployedPath, 'utf-8')
    const edited: CwcFile = {
      ...first.body.updatedCwc,
      nodes: first.body.updatedCwc.nodes.map(node => ({
        ...node,
        agent: { ...node.agent, systemPrompt: '# Commit Race Export\n\nThese edited bytes are awaiting export.' },
      })),
    }
    const saved = await post<{ revision: string }>('/api/workflows', {
      path: authority.path,
      content: edited,
      expectedRevision: first.body.recipeRevision,
    })
    expect(saved.status).toBe(200)
    const persisted = await readPersistedWorkflow(authority.path, edited.meta.id)
    const external: CwcFile = {
      ...edited,
      meta: { ...edited.meta, description: 'external editor won during recipe commit' },
    }

    await expect(exportWorkflow(edited, target, {
      commitUpdatedCwc: async updatedCwc => {
        await fs.writeFile(authority.path, serializedWorkflow(external), 'utf-8')
        await replaceWorkflowFileAtomically(authority.path, updatedCwc, persisted.mode, {
          expectedRevision: persisted.revision,
        })
      },
    })).rejects.toThrow(/changed while CWC was preparing/i)

    expect(await fs.readFile(deployedPath, 'utf-8')).toBe(priorDeployment)
    expect(JSON.parse(await fs.readFile(authority.path, 'utf-8'))).toEqual(external)
  })

  it('rejects an unsaved export snapshot even with a current revision', async () => {
    const persisted = skillFixture('unsaved-export', 'Unsaved Export')
    const authority = await createRecipe(persisted)
    const unsaved: CwcFile = {
      ...persisted,
      meta: { ...persisted.meta, description: 'not saved yet' },
    }
    const { target, skillPath } = projectTarget('unsaved-export-project')

    const result = await post<{ error: string }>('/api/export', {
      cwcFile: unsaved,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })

    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/snapshot does not match/i)
    await expect(fs.access(path.join(skillPath, 'unsaved-export', 'SKILL.md'))).rejects.toThrow()
  })

  it('rejects a stale delete and preserves the newer recipe and deployment', async () => {
    const cwc = skillFixture('stale-delete', 'Stale Delete')
    const authority = await createRecipe(cwc)
    const { target, skillPath } = projectTarget('stale-delete-project')
    const exported = await post<{ updatedCwc: CwcFile; recipeRevision: string }>('/api/export', {
      cwcFile: cwc,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })
    expect(exported.status).toBe(200)
    const newer: CwcFile = {
      ...exported.body.updatedCwc,
      meta: { ...exported.body.updatedCwc.meta, description: 'newer editor after deployment' },
    }
    expect((await post('/api/workflows', {
      path: authority.path,
      content: newer,
      expectedRevision: exported.body.recipeRevision,
    })).status).toBe(200)

    const result = await post<{ error: string }>('/api/export/delete', {
      cwcFile: exported.body.updatedCwc,
      target,
      workflowPath: authority.path,
      expectedRevision: exported.body.recipeRevision,
    })

    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/another editor/i)
    expect((JSON.parse(await fs.readFile(authority.path, 'utf-8')) as CwcFile).meta.description).toBe('newer editor after deployment')
    await expect(fs.access(path.join(skillPath, 'stale-delete', 'SKILL.md'))).resolves.toBeUndefined()
  })

  it('clears persisted deployment identity only after an authorized delete', async () => {
    const cwc = skillFixture('authorized-delete', 'Authorized Delete')
    const authority = await createRecipe(cwc)
    const { target, skillPath } = projectTarget('authorized-delete-project')
    const exported = await post<{ updatedCwc: CwcFile; recipeRevision: string }>('/api/export', {
      cwcFile: cwc,
      target,
      workflowPath: authority.path,
      expectedRevision: authority.revision,
    })
    expect(exported.status).toBe(200)
    const deployedPath = path.join(skillPath, 'authorized-delete', 'SKILL.md')
    await expect(fs.access(deployedPath)).resolves.toBeUndefined()

    const deleted = await post<{
      updatedCwc: CwcFile
      recipeRevision: string
      deleted: string[]
    }>('/api/export/delete', {
      cwcFile: exported.body.updatedCwc,
      target,
      workflowPath: authority.path,
      expectedRevision: exported.body.recipeRevision,
    })

    expect(deleted.status).toBe(200)
    await expect(fs.access(deployedPath)).rejects.toThrow()
    expect(deleted.body.updatedCwc.meta.exportedWorkflowSlug).toBeUndefined()
    expect(deleted.body.updatedCwc.nodes.every(node => node.exportedSlug === null)).toBe(true)
    const rawRecipe = await fs.readFile(authority.path, 'utf-8')
    expect(JSON.parse(rawRecipe)).toEqual(deleted.body.updatedCwc)
    expect(revision(rawRecipe)).toBe(deleted.body.recipeRevision)
  })

  it('returns success after committed export and delete even when post-commit notification fails', async () => {
    const localRoot = path.join(tmpDir, 'notification-failure')
    const localWorkflows = path.join(localRoot, 'workflows')
    await fs.mkdir(localWorkflows, { recursive: true })
    const cwc = skillFixture('notification-failure', 'Notification Failure')
    const recipePath = path.join(localWorkflows, 'notification-failure.cwc')
    const rawRecipe = serializedWorkflow(cwc)
    await fs.writeFile(recipePath, rawRecipe, 'utf-8')
    const mutations = createWorkflowMutationCoordinator(localWorkflows)
    let notifications = 0
    const notificationFailure = async () => {
      notifications++
      throw new Error('injected post-commit notification failure')
    }
    const localApp = express()
    localApp.use(express.json())
    localApp.use('/api/export/delete', exportDeleteRouter({ mutations, onSaved: notificationFailure }))
    localApp.use('/api/export', exportRouter({ mutations, onSaved: notificationFailure }))
    const localServer = await new Promise<http.Server>(resolve => {
      const listening = localApp.listen(0, () => resolve(listening))
    })
    const localPort = (localServer.address() as { port: number }).port
    const target = { type: 'project' as const, projectDir: path.join(localRoot, 'project') }
    try {
      const exportResponse = await fetch(`http://localhost:${localPort}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwcFile: cwc,
          target,
          workflowPath: recipePath,
          expectedRevision: revision(rawRecipe),
        }),
      })
      expect(exportResponse.status).toBe(200)
      const exported = await exportResponse.json() as { updatedCwc: CwcFile; recipeRevision: string }

      const deleteResponse = await fetch(`http://localhost:${localPort}/api/export/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwcFile: exported.updatedCwc,
          target,
          workflowPath: recipePath,
          expectedRevision: exported.recipeRevision,
        }),
      })
      expect(deleteResponse.status).toBe(200)
      expect(notifications).toBe(2)
      const persisted = JSON.parse(await fs.readFile(recipePath, 'utf-8')) as CwcFile
      expect(persisted.meta.exportedWorkflowSlug).toBeUndefined()
      await expect(fs.access(path.join(target.projectDir, '.claude', 'skills', 'notification-failure', 'SKILL.md'))).rejects.toThrow()
    } finally {
      await new Promise<void>(resolve => localServer.close(() => resolve()))
    }
  })
})
