import { it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import { exportWorkflow, type ExportTarget } from '../../src/export/exporter.js'
import type { CwcFile } from '../../src/schema.js'
import matter from 'gray-matter'

const FIXTURE: CwcFile = {
  meta: { id: 'preview-uuid', name: 'Preview Test', description: 'desc', version: 1, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
  nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, startTrigger: 'to implement', agent: { name: 'Developer', description: 'Builds things', completionCriteria: 'Task complete', tools: ['Read','Write'], model: 'inherit' } }],
  edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'The workflow is complete.', terminalType: 'complete', context: [] }],
}

let server: http.Server
let port: number

beforeAll(async () => {
  const app = createApp({ staticDir: null })
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() }) })
})
afterAll(() => server.close())

async function preview(cwcFile: CwcFile, target: ExportTarget = { type: 'user' }, skillsDir?: string) {
  const res = await fetch(`http://localhost:${port}/api/export/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwcFile, target, skillsDir }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ files: { path: string; content: string }[]; warnings: string[] }>
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
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
