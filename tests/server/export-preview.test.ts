import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import { exportWorkflow, type ExportTarget } from '../../src/export/exporter.js'
import { CWC_FILE_VERSION, type CwcFile } from '../../src/schema.js'
import matter from 'gray-matter'

const FIXTURE: CwcFile = {
  meta: { id: 'preview-uuid', name: 'Preview Test', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, startTrigger: 'to implement', agent: { name: 'Developer', description: 'Builds things', completionCriteria: 'Task complete', tools: ['Read','Write'], model: 'inherit' } }],
  edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'The workflow is complete.', terminalType: 'complete', context: [] }],
}

let server: http.Server
let port: number
let serverTmp: string
let workflowsDir: string

beforeAll(async () => {
  serverTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-export-preview-server-'))
  workflowsDir = path.join(serverTmp, 'workflows')
  const app = createApp({
    staticDir: null,
    workflowsDir,
    userHomeDir: path.join(serverTmp, 'home'),
    recentsPath: path.join(serverTmp, 'recents.json'),
    runsDir: path.join(serverTmp, 'runs'),
    worktreesRoot: path.join(serverTmp, 'worktrees'),
    automationStatePath: path.join(serverTmp, 'automation-state.json'),
    configPath: path.join(serverTmp, 'config.json'),
    automationScanPath: path.join(serverTmp, 'automation-scan.json'),
    enableNotifier: false,
  })
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() }) })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(serverTmp, { recursive: true, force: true })
})

async function preview(cwcFile: CwcFile, target: ExportTarget = { type: 'user' }, skillsDir?: string) {
  const res = await fetch(`http://localhost:${port}/api/export/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwcFile, target, skillsDir }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{
    files: { path: string; content: string }[]
    deletions: string[]
    warnings: string[]
    artifactKind: 'workflow' | 'skill'
    artifactSlug: string
  }>
}

function workflowSkill(files: { path: string; content: string }[], slug = 'cwc-preview-test') {
  const skillFile = files.find((f) => f.path.replaceAll('\\', '/').endsWith(`${slug}/SKILL.md`))
  expect(skillFile).toBeDefined()
  return skillFile!.content
}

it('POST /api/export/preview returns file contents without writing to disk', async () => {
  const { files, warnings } = await preview(FIXTURE)
  expect(files.length).toBeGreaterThanOrEqual(1)
  const agentFile = files.find((f) => f.path.endsWith('developer.md'))
  expect(agentFile).toBeDefined()
  expect(agentFile!.content).toContain('name: developer')
  expect(agentFile!.content).toContain('## Completion Criteria')
  expect(workflowSkill(files)).toContain('disable-model-invocation: true')
  expect(workflowSkill(files)).toContain('<!-- cwc:bespoke-agents:developer -->')
  expect(Array.isArray(warnings)).toBe(true)
})

it('POST /api/export/preview keeps disable-model-invocation when model invocation is off', async () => {
  const { files } = await preview({ ...FIXTURE, meta: { ...FIXTURE.meta, modelInvocation: 'off' } })
  const skillContent = workflowSkill(files)
  expect(matter(skillContent).data['disable-model-invocation']).toBe(true)
})

it('POST /api/export/preview omits disable-model-invocation when model invocation is auto', async () => {
  const { files } = await preview({ ...FIXTURE, meta: { ...FIXTURE.meta, modelInvocation: 'auto' } })
  const skillContent = workflowSkill(files)
  expect(matter(skillContent).data).not.toHaveProperty('disable-model-invocation')
  expect(skillContent).not.toContain('disable-model-invocation')
})

it('POST /api/export/preview matches real workflow skill content after agent rename', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-preview-parity-'))
  try {
    const cwc: CwcFile = {
      ...FIXTURE,
      meta: { ...FIXTURE.meta, id: 'preview-rename', name: 'Preview Rename' },
      nodes: [{
        ...FIXTURE.nodes[0],
        exportedSlug: 'old-developer',
        agent: { ...FIXTURE.nodes[0].agent, name: 'New Developer' },
      }],
    }
    const target = { type: 'project' as const, projectDir: tmp }
    const skillsDir = path.join(tmp, 'custom-skills')

    const { files } = await preview(cwc, target, skillsDir)
    await exportWorkflow(cwc, target, { skillsDir })
    const realSkill = await fs.readFile(path.join(skillsDir, 'cwc-preview-rename', 'SKILL.md'), 'utf-8')

    expect(workflowSkill(files, 'cwc-preview-rename')).toBe(realSkill)
    expect(realSkill).toContain('subagent_type: "new-developer"')
    expect(realSkill).not.toContain('subagent_type: "old-developer"')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

it('POST /api/export/preview includes reference-node model overrides like real export', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-preview-ref-'))
  try {
    const cwc: CwcFile = {
      meta: { id: 'preview-ref', name: 'Preview Ref', description: '', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
      nodes: [{
        id: 'ref-1',
        position: { x: 0, y: 0 },
        exportedSlug: 'reviewer',
        agentRef: 'reviewer',
        startTrigger: 'review the changes',
        agent: { name: 'Reviewer', description: '', completionCriteria: '', model: 'opus' },
      }],
      edges: [{ id: 'e1', from: 'ref-1', to: null, trigger: 'done', terminalType: 'complete', context: [] }],
    }
    const target = { type: 'project' as const, projectDir: tmp }
    const skillsDir = path.join(tmp, 'skills')

    const { files } = await preview(cwc, target, skillsDir)
    await exportWorkflow(cwc, target, { skillsDir })
    const realSkill = await fs.readFile(path.join(skillsDir, 'cwc-preview-ref', 'SKILL.md'), 'utf-8')

    expect(workflowSkill(files, 'cwc-preview-ref')).toBe(realSkill)
    expect(realSkill).toContain('Workflow-specific configuration: model (opus).')
    expect(realSkill).toContain('<!-- cwc:bespoke-agents:- -->')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

function skillFixture(id = 'preview-skill'): CwcFile {
  const now = new Date().toISOString()
  return {
    meta: {
      id,
      name: 'Release Notes',
      description: 'Prepare release notes.',
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
        name: 'Release Notes',
        description: 'Use when preparing release notes from completed changes.',
        completionCriteria: '',
        systemPrompt: '# Release Notes\n\n1. Read the completed changes.\n2. Write concise release notes.',
      },
    }],
    edges: [],
  }
}

it('skill preview is one file and byte-identical to a real project export without overrides', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-skill-preview-parity-'))
  try {
    const cwc = skillFixture()
    const target = { type: 'project' as const, projectDir: tmp }
    const result = await preview(cwc, target)
    const expectedPath = path.join(tmp, '.claude', 'skills', 'release-notes', 'SKILL.md')

    expect(result.artifactKind).toBe('skill')
    expect(result.artifactSlug).toBe('release-notes')
    expect(result.files.map(file => file.path)).toEqual([expectedPath])
    expect(result.deletions).toEqual([])

    const createResponse = await fetch(`http://localhost:${port}/api/workflows/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: cwc }),
    })
    expect(createResponse.status).toBe(201)
    const authority = await createResponse.json() as { path: string; revision: string }

    const exportResponse = await fetch(`http://localhost:${port}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwcFile: cwc,
        target,
        workflowPath: authority.path,
        expectedRevision: authority.revision,
      }),
    })
    expect(exportResponse.status).toBe(200)
    const exported = await exportResponse.json() as { updatedCwc: CwcFile; recipeRevision: string }
    expect(exported.recipeRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(await fs.readFile(authority.path, 'utf-8'))).toEqual(exported.updatedCwc)
    expect(await fs.readFile(expectedPath, 'utf-8')).toBe(result.files[0].content)
    await expect(fs.access(path.join(tmp, '.claude', 'agents'))).rejects.toThrow()
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

it('graduation preview reports the owned plain skill deletion alongside new workflow files', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-graduate-preview-'))
  try {
    const target = { type: 'project' as const, projectDir: tmp }
    const first = await exportWorkflow(skillFixture('preview-graduate'), target)
    const workflow: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, artifactKind: 'workflow', artifactTier: 'workflow' },
      edges: [{ id: 'done', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }],
    }

    const result = await preview(workflow, target)

    expect(result.deletions).toEqual([
      path.join(tmp, '.claude', 'skills', 'release-notes', 'SKILL.md'),
    ])
    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining([
      path.join(tmp, '.claude', 'agents', 'release-notes.md'),
      path.join(tmp, '.claude', 'skills', 'cwc-release-notes', 'SKILL.md'),
    ]))
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

it('returns 400 for a structurally invalid managed skill', async () => {
  const cwc = skillFixture('invalid-preview-skill')
  cwc.edges = [{ id: 'bad', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }]
  const res = await fetch(`http://localhost:${port}/api/export/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwcFile: cwc, target: { type: 'user' } }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: expect.stringMatching(/cannot contain edges/i) })
})

it('returns 409 during preview for a destination that real export would refuse', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-preview-conflict-'))
  try {
    const target = { type: 'project' as const, projectDir: tmp }
    const skillPath = path.join(tmp, '.claude', 'skills', 'release-notes', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '# user-owned skill\n', 'utf-8')

    const res = await fetch(`http://localhost:${port}/api/export/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwcFile: skillFixture('preview-conflict'), target }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ path: skillPath })
    expect(await fs.readFile(skillPath, 'utf-8')).toBe('# user-owned skill\n')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
