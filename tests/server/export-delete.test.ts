import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { exportWorkflow } from '../../src/export/exporter.js'
import { deleteExport } from '../../src/server/api/export-delete.js'
import type { CwcFile } from '../../src/schema.js'

describe('deleteExport', () => {
  it('deletes files from the supplied userDir, not the process home directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-export-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'wf-delete', name: 'Delete Me', description: '', version: 1, created: now, updated: now },
      nodes: [{
        id: 'n1',
        position: { x: 0, y: 0 },
        exportedSlug: null,
        agent: { name: 'Owned Agent', description: '', completionCriteria: 'done' },
      }, {
        id: 'g1',
        position: { x: 1, y: 0 },
        exportedSlug: null,
        nodeType: 'gate',
        agent: { name: 'Approval Gate', description: '', completionCriteria: '' },
      }],
      edges: [
        { id: 'e1', from: 'n1', to: 'g1', trigger: 'review' },
        { id: 'e2', from: 'g1', to: null, trigger: 'done', terminalType: 'complete' },
      ],
    }
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(cwc, target, { skillsDir: path.join(tmp, '.claude', 'skills') })

    const result = await deleteExport(first.updatedCwc, target)

    expect(result.deleted.some(p => p.endsWith(path.join('.claude', 'agents', 'owned-agent.md')))).toBe(true)
    expect(result.deleted.some(p => p.endsWith(path.join('.claude', 'skills', 'cwc-delete-me')))).toBe(true)
    expect([...result.deleted, ...result.skipped, ...result.notFound].some(p => p.includes('approval-gate'))).toBe(false)
    await expect(fs.access(path.join(tmp, '.claude', 'agents', 'owned-agent.md'))).rejects.toThrow()
    await expect(fs.access(path.join(tmp, '.claude', 'skills', 'cwc-delete-me'))).rejects.toThrow()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('restores every deployment file when cleared recipe authority does not commit', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-authority-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'delete-authority', name: 'Delete Authority', description: '', version: 1, created: now, updated: now },
      nodes: [{
        id: 'n1',
        position: { x: 0, y: 0 },
        exportedSlug: null,
        agent: { name: 'Authority Agent', description: '', completionCriteria: 'done' },
      }],
      edges: [{ id: 'done', from: 'n1', to: null, trigger: 'done', terminalType: 'complete' }],
    }
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(cwc, target)
    const agentPath = path.join(tmp, '.claude', 'agents', 'authority-agent.md')
    const skillPath = path.join(tmp, '.claude', 'skills', 'cwc-delete-authority', 'SKILL.md')
    const [agentBytes, skillBytes] = await Promise.all([
      fs.readFile(agentPath, 'utf-8'),
      fs.readFile(skillPath, 'utf-8'),
    ])

    await expect(deleteExport(first.updatedCwc, target, {
      commitUpdatedCwc: async () => {
        throw new Error('injected delete recipe CAS conflict')
      },
    })).rejects.toThrow('injected delete recipe CAS conflict')

    expect(await fs.readFile(agentPath, 'utf-8')).toBe(agentBytes)
    expect(await fs.readFile(skillPath, 'utf-8')).toBe(skillBytes)
    const [agentEntries, skillEntries] = await Promise.all([
      fs.readdir(path.dirname(agentPath)),
      fs.readdir(path.join(tmp, '.claude', 'skills')),
    ])
    expect([...agentEntries, ...skillEntries].some(name => /\.cwc-delete-.*\.bak$/.test(name))).toBe(false)
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('deletes a managed plain skill using its persisted exported slug after a rename', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-skill-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: {
        id: 'skill-delete', name: 'Old Skill', description: '', version: 2, created: now, updated: now,
        artifactKind: 'skill', artifactTier: 'skill',
      },
      nodes: [{
        id: 'skill-node', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: {
          name: 'Old Skill', description: 'Use when doing the old task.', completionCriteria: '',
          systemPrompt: '# Old Skill\n\nDo the task.',
        },
      }],
      edges: [],
    }
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(cwc, target)
    const renamed: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, name: 'New Skill' },
      nodes: first.updatedCwc.nodes.map(node => ({ ...node, agent: { ...node.agent, name: 'New Skill' } })),
    }

    const result = await deleteExport(renamed, target)

    expect(result.deleted).toContain(path.join(tmp, '.claude', 'skills', 'old-skill'))
    expect(result.notFound).toEqual([])
    await expect(fs.access(path.join(tmp, '.claude', 'skills', 'old-skill'))).rejects.toThrow()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('preserves unowned files beside a deleted managed skill', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-skill-assets-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: {
        id: 'skill-assets', name: 'Asset Skill', description: '', version: 2, created: now, updated: now,
        artifactKind: 'skill', artifactTier: 'skill',
      },
      nodes: [{
        id: 'skill-node', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: {
          name: 'Asset Skill', description: 'Use when doing an asset task.', completionCriteria: '',
          systemPrompt: '# Asset Skill\n\nDo the task.',
        },
      }],
      edges: [],
    }
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(cwc, target)
    const skillDir = path.join(tmp, '.claude', 'skills', 'asset-skill')
    await fs.writeFile(path.join(skillDir, 'reference.md'), 'user content')

    const result = await deleteExport(first.updatedCwc, target)

    expect(result.deleted).toContain(path.join(skillDir, 'SKILL.md'))
    expect(result.skipped).toContain(skillDir)
    expect(await fs.readFile(path.join(skillDir, 'reference.md'), 'utf-8')).toBe('user content')
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('cleans a legacy name-derived workflow agent when deleting a demoted skill', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-demoted-skill-'))
    const agentsDir = path.join(tmp, '.claude', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    const agentFile = path.join(agentsDir, 'old-agent.md')
    await fs.writeFile(agentFile, '---\nname: old-agent\n---\n<!-- cwc:node:n1:workflow:wf-demoted -->')
    const cwc: CwcFile = {
      meta: {
        id: 'wf-demoted', name: 'Old Agent', description: '', version: 2,
        artifactKind: 'skill', artifactTier: 'skill', created: '', updated: '',
      },
      nodes: [{
        id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: {
          name: 'Old Agent', description: 'Use when doing the task.', completionCriteria: '',
          systemPrompt: '# Old Agent\n\nDo the task.',
        },
      }],
      edges: [],
    }

    const result = await deleteExport(cwc, { type: 'user', userDir: tmp })

    expect(result.deleted).toContain(agentFile)
    await expect(fs.access(agentFile)).rejects.toThrow()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('deletes both the current workflow agent and a distinct persisted retry candidate', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-current-agent-'))
    const agentsDir = path.join(tmp, '.claude', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    const currentAgent = path.join(agentsDir, 'current-agent.md')
    await fs.writeFile(currentAgent, '---\nname: current-agent\n---\n<!-- cwc:node:n1:workflow:wf-current -->')
    const cwc: CwcFile = {
      meta: {
        id: 'wf-current', name: 'Current Workflow', description: '', version: 2,
        artifactKind: 'workflow', artifactTier: 'workflow', created: '', updated: '',
      },
      nodes: [{
        id: 'n1', position: { x: 0, y: 0 }, exportedSlug: 'obsolete-agent',
        agent: { name: 'Current Agent', description: '', completionCriteria: 'done' },
      }],
      edges: [{ id: 'done', from: 'n1', to: null, trigger: 'done', terminalType: 'complete' }],
    }

    const result = await deleteExport(cwc, { type: 'user', userDir: tmp })

    expect(result.deleted).toContain(currentAgent)
    expect(result.notFound).toContain(path.join(agentsDir, 'obsolete-agent.md'))
    expect(result.notFound).not.toContain(currentAgent)
    await expect(fs.access(currentAgent)).rejects.toThrow()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('deletes separately tracked obsolete skills with the runnable deployment', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-pending-skills-'))
    const now = new Date().toISOString()
    const target = { type: 'user' as const, userDir: tmp }
    const cwc: CwcFile = {
      meta: {
        id: 'skill-pending', name: 'Current Skill', description: '', version: 2,
        artifactKind: 'skill', artifactTier: 'skill', created: now, updated: now,
        exportedWorkflowSlug: 'current-skill',
        pendingExportCleanup: { skillSlugs: ['obsolete-skill'], agentSlugs: ['obsolete-agent'] },
      },
      nodes: [{
        id: 'skill-node', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: {
          name: 'Current Skill', description: 'Use for current work.', completionCriteria: '',
          systemPrompt: '# Current Skill\n\nDo the work.',
        },
      }],
      edges: [],
    }
    for (const slug of ['current-skill', 'obsolete-skill']) {
      const skillDir = path.join(tmp, '.claude', 'skills', slug)
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${slug}\n---\n<!-- cwc:workflow:skill-pending -->`)
    }
    const obsoleteAgent = path.join(tmp, '.claude', 'agents', 'obsolete-agent.md')
    await fs.mkdir(path.dirname(obsoleteAgent), { recursive: true })
    await fs.writeFile(obsoleteAgent, '---\nname: obsolete-agent\n---\n<!-- cwc:node:old:workflow:skill-pending -->')

    const result = await deleteExport(cwc, target)

    expect(result.deleted).toEqual(expect.arrayContaining([
      path.join(tmp, '.claude', 'skills', 'current-skill'),
      path.join(tmp, '.claude', 'skills', 'obsolete-skill'),
      obsoleteAgent,
    ]))
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('serializes delete and export mutations that share a target', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-export-delete-lease-'))
    const now = new Date().toISOString()
    const makeSkill = (id: string): CwcFile => ({
      meta: {
        id, name: 'Shared Skill', description: '', version: 2, created: now, updated: now,
        artifactKind: 'skill', artifactTier: 'skill',
      },
      nodes: [{
        id: 'skill-node', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: {
          name: 'Shared Skill', description: 'Use for shared work.', completionCriteria: '',
          systemPrompt: '# Shared Skill\n\nDo the work.',
        },
      }],
      edges: [],
    })
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(makeSkill('lease-old'), target)

    const [deletion, replacement] = await Promise.all([
      deleteExport(first.updatedCwc, target),
      exportWorkflow(makeSkill('lease-new'), target),
    ])

    expect(deletion.deleted).toContain(path.join(tmp, '.claude', 'skills', 'shared-skill'))
    expect(replacement.updatedCwc.meta.exportedWorkflowSlug).toBe('shared-skill')
    const raw = await fs.readFile(
      path.join(tmp, '.claude', 'skills', 'shared-skill', 'SKILL.md'),
      'utf-8',
    )
    expect(raw).toContain('<!-- cwc:workflow:lease-new -->')
    await fs.rm(tmp, { recursive: true, force: true })
  })
})
