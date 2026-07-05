import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ExportConflictError, exportWorkflow, ExportTarget } from '../../src/export/exporter.js'
import type { CwcFile } from '../../src/schema.js'
import matter from 'gray-matter'

// We'll write to a real temp dir, cleaned up after each test
let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join('/tmp', `cwc-test-${randomUUID()}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function loadFixture(name: string) {
  const raw = await fs.readFile(
    path.join(import.meta.dirname, '..', 'fixtures', name),
    'utf-8',
  )
  return JSON.parse(raw)
}

function agentOwnershipComment(nodeId: string, workflowId: string) {
  return `<!-- cwc:node:${nodeId}:workflow:${workflowId} -->`
}

describe('exportWorkflow — linear.cwc', () => {
  it('writes three agent files and one skill file', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    const files = await fs.readdir(agentsDir)
    expect(files.sort()).toEqual(['architect.md', 'developer.md', 'reviewer.md'])
  })

  it('each agent file has valid YAML frontmatter', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    for (const file of ['architect.md', 'developer.md', 'reviewer.md']) {
      const content = await fs.readFile(path.join(agentsDir, file), 'utf-8')
      expect(() => matter(content)).not.toThrow()
      const { data } = matter(content)
      expect(typeof data.name).toBe('string')
      expect(typeof data.description).toBe('string')
    }
  })

  it('every orchestrator subagent_type matches an exported agent frontmatter name', async () => {
    // Regression: Claude Code resolves subagent_type against the agent file's frontmatter
    // `name`, not its filename. If the orchestrator dispatches by slug but agents are named
    // with their human title, every dispatch fails with "agent type not found".
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    const agentFiles = await fs.readdir(agentsDir)
    const nameByStem = new Map<string, string>()
    for (const file of agentFiles) {
      const content = await fs.readFile(path.join(agentsDir, file), 'utf-8')
      const stem = file.replace(/\.md$/, '')
      const name = String(matter(content).data.name)
      // The agent's name must equal its filename stem (both the slug)…
      expect(name).toBe(stem)
      nameByStem.set(name, stem)
    }

    const skillContent = await fs.readFile(path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'), 'utf-8')
    const dispatched = [...skillContent.matchAll(/subagent_type: "([^"]+)"/g)].map(m => m[1])
    expect(dispatched.length).toBeGreaterThan(0)
    // …and every slug the orchestrator dispatches must be a registered agent name.
    for (const slug of dispatched) {
      expect(nameByStem.has(slug)).toBe(true)
    }
  })

  it('agent ownership comment matches node id and workflow id', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    const architectContent = await fs.readFile(path.join(agentsDir, 'architect.md'), 'utf-8')
    const lines = architectContent.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe(agentOwnershipComment('node-a', 'linear-uuid'))
  })

  it('workflow skill has disable-model-invocation: true and correct fields', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    const { data } = matter(skillContent)
    expect(data['disable-model-invocation']).toBe(true)
    expect(data.description).toBe('A sequential A to B to C workflow')
    expect(data.name).toBe('Linear Pipeline')
  })

  it("keeps disable-model-invocation: true when meta.modelInvocation is 'off'", async () => {
    const cwc = await loadFixture('linear.cwc')
    cwc.meta.modelInvocation = 'off'
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    expect(matter(skillContent).data['disable-model-invocation']).toBe(true)
  })

  it('omits disable-model-invocation when meta.modelInvocation is auto', async () => {
    const cwc = await loadFixture('linear.cwc')
    cwc.meta.modelInvocation = 'auto'
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    const { data } = matter(skillContent)
    expect(data).not.toHaveProperty('disable-model-invocation')
    expect(skillContent).not.toContain('disable-model-invocation')
  })

  it('workflow skill ownership comment is last non-blank line', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    const lines = skillContent.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe('<!-- cwc:workflow:linear-uuid -->')
  })

  it('re-export overwrites files and updates exportedSlug in cwc', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }
    const result1 = await exportWorkflow(cwc, target, opts)
    const result2 = await exportWorkflow(result1.updatedCwc, target, opts)

    expect(result2.updatedCwc.nodes[0].exportedSlug).toBe('architect')
    // No orphan files
    const files = await fs.readdir(path.join(tmpDir, '.claude', 'agents'))
    expect(files).toHaveLength(3)
  })

  it('refuses to overwrite an existing hand-authored agent file', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(path.join(agentsDir, 'architect.md'), '---\nname: Architect\n---\nhand-written\n')

    await expect(exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') }))
      .rejects.toBeInstanceOf(ExportConflictError)
  })

  it('refuses to overwrite an existing workflow skill from another workflow', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    const skillDir = path.join(skillsDir, 'cwc-linear-pipeline')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# x\n<!-- cwc:workflow:other-workflow -->\n')

    await expect(exportWorkflow(cwc, target, { skillsDir }))
      .rejects.toBeInstanceOf(ExportConflictError)
  })
})

describe('exportWorkflow — parallel.cwc', () => {
  it('fan-out nodes emitted as grouped parallel step in skill body', async () => {
    const cwc = await loadFixture('parallel.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-parallel-split', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toContain('**Frontend Dev** and **Backend Dev** in parallel')
    // Should NOT have them as separate numbered items
    const numberedLines = skillContent.split('\n').filter(l => /^\d+\./.test(l))
    expect(numberedLines.filter(l => l.includes('Frontend Dev') || l.includes('Backend Dev'))).toHaveLength(1)
  })
})

describe('exportWorkflow — gate-loop.cwc', () => {
  it('back-edge appears after forward steps in skill body', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-gate-loop', 'SKILL.md'),
      'utf-8',
    )
    const passIdx = skillContent.indexOf('If the review passes')
    const failIdx = skillContent.indexOf('If the review fails')
    expect(passIdx).toBeGreaterThan(0)
    expect(failIdx).toBeGreaterThan(passIdx)
  })

  it('back-edge appears exactly once — no infinite recursion', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-gate-loop', 'SKILL.md'),
      'utf-8',
    )
    const matches = skillContent.match(/If the review fails/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('step 1 uses startTrigger from node', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-gate-loop', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toContain('**Developer**')
    expect(skillContent).toContain('subagent_type: "developer"')
    expect(skillContent).toContain('to implement the feature')
  })
})

describe('exportWorkflow — skills.cwc', () => {
  it('agent file contains skills block with exact separator when skill found', async () => {
    const cwc = await loadFixture('skills.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    // Provide a mock skills dir with one matching skill
    const mockSkillsDir = path.join(tmpDir, 'mock-user-skills')
    await fs.mkdir(path.join(mockSkillsDir, 'brainstorming'), { recursive: true })
    await fs.writeFile(
      path.join(mockSkillsDir, 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: Explores requirements\n---\n',
    )
    await exportWorkflow(cwc, target, {
      skillsDir: path.join(tmpDir, 'skills'),
      userSkillsDir: mockSkillsDir,
    })

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'agents', 'full-stack-dev.md'),
      'utf-8',
    )
    expect(content).toContain('\n\n---\n## Workflow Skills\n\n')
    expect(content).toContain('Use the `brainstorming` skill. (Explores requirements)')
  })

  it('emits warnings for skills that cannot be resolved', async () => {
    const cwc = await loadFixture('skills.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    // No userSkillsDir — all 3 skills will fail resolution (no real ~/.claude/skills in test env)
    const result = await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })
    // The skills.cwc fixture has 3 skills: brainstorming, superpowers:writing-plans, nonexistent-skill
    // All will be unresolved in isolation — at least 1 warning expected
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some(w => w.includes('nonexistent-skill'))).toBe(true)
  })

  it('ownership comment immediately follows last skill line — no blank line', async () => {
    const cwc = await loadFixture('skills.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'agents', 'full-stack-dev.md'),
      'utf-8',
    )
    // Find last skill line and check next line is ownership comment
    const idx = content.lastIndexOf('Use the `')
    const afterSkill = content.slice(content.indexOf('\n', idx) + 1)
    expect(afterSkill.startsWith('<!-- cwc:node:')).toBe(true)
  })
})

describe('exportWorkflow — renamed node', () => {
  it('deletes old file and writes new file when name changes', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }

    // First export
    const result1 = await exportWorkflow(cwc, target, opts)

    // Rename first node
    const modified = {
      ...result1.updatedCwc,
      nodes: result1.updatedCwc.nodes.map((n: any) =>
        n.id === 'node-a' ? { ...n, agent: { ...n.agent, name: 'Lead Architect' } } : n
      ),
    }
    const result2 = await exportWorkflow(modified, target, opts)

    const files = await fs.readdir(path.join(tmpDir, '.claude', 'agents'))
    expect(files).toContain('lead-architect.md')
    expect(files).not.toContain('architect.md')
    expect(result2.updatedCwc.nodes.find((n: any) => n.id === 'node-a').exportedSlug).toBe('lead-architect')
  })

  it('proceeds without error when old file missing on disk', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }
    const result1 = await exportWorkflow(cwc, target, opts)

    // Manually delete the file (simulate external deletion)
    await fs.unlink(path.join(tmpDir, '.claude', 'agents', 'architect.md'))

    const modified = {
      ...result1.updatedCwc,
      nodes: result1.updatedCwc.nodes.map((n: any) =>
        n.id === 'node-a' ? { ...n, agent: { ...n.agent, name: 'Lead Architect' } } : n
      ),
    }
    await expect(exportWorkflow(modified, target, opts)).resolves.not.toThrow()
  })
})

describe('exportWorkflow — duplicate agent slugs', () => {
  it('refuses to export two bespoke agents whose names slugify to the same file', async () => {
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'wf-dupe', name: 'Dupe Flow', description: '', version: 1, created: now, updated: now },
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'Run Tests', description: '', completionCriteria: 'done' } },
        { id: 'n2', position: { x: 1, y: 0 }, exportedSlug: null, agent: { name: 'Run Tests.', description: '', completionCriteria: 'done' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', trigger: 'next' },
        { id: 'e2', from: 'n2', to: null, trigger: 'done', terminalType: 'complete' },
      ],
    }

    await expect(exportWorkflow(cwc, { type: 'project', projectDir: tmpDir }, { skillsDir: path.join(tmpDir, 'skills') }))
      .rejects.toThrow(/both export to run-tests/)
  })

  it('does not delete a sibling agent file during stale old-slug cleanup', async () => {
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'wf-sibling', name: 'Sibling Flow', description: '', version: 1, created: now, updated: now },
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'Alpha', description: '', completionCriteria: 'done' } },
        { id: 'n2', position: { x: 1, y: 0 }, exportedSlug: null, agent: { name: 'Beta', description: '', completionCriteria: 'done' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', trigger: 'next' },
        { id: 'e2', from: 'n2', to: null, trigger: 'done', terminalType: 'complete' },
      ],
    }
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }
    const first = await exportWorkflow(cwc, target, opts)
    const stale = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node =>
        node.id === 'n1'
          ? { ...node, exportedSlug: 'beta', agent: { ...node.agent, name: 'Gamma' } }
          : node
      ),
    }

    await exportWorkflow(stale, target, opts)

    const beta = await fs.readFile(path.join(tmpDir, '.claude', 'agents', 'beta.md'), 'utf-8')
    expect(beta).toContain(agentOwnershipComment('n2', 'wf-sibling'))
    await fs.access(path.join(tmpDir, '.claude', 'agents', 'gamma.md'))
  })
})

describe('observability instrumentation', () => {
  function obsCwc(observability?: { enabled: boolean }): CwcFile {
    const now = new Date().toISOString()
    return {
      meta: { id: 'wf-obs', name: 'Obs Flow', description: '', version: 1, created: now, updated: now, ...(observability ? { observability } : {}) },
      nodes: [{
        id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: { name: 'Solo Agent', description: 'does the thing', completionCriteria: 'thing done' },
      }],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'Done.', terminalType: 'complete' }],
    }
  }

  it('exported workflow skill contains run logging by default', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-obs-'))
    await exportWorkflow(obsCwc(), { type: 'user', userDir: tmp }, { skillsDir: path.join(tmp, 'skills') })
    const skill = await fs.readFile(path.join(tmp, 'skills', 'cwc-obs-flow', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('## Run Logging')
    expect(skill).toContain('"workflowId":"wf-obs"')
    expect(skill).toContain('"workflowSlug":"cwc-obs-flow"')
    await fs.rm(tmp, { recursive: true })
  })

  it('exported workflow skill omits run logging when disabled', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-obs-off-'))
    await exportWorkflow(obsCwc({ enabled: false }), { type: 'user', userDir: tmp }, { skillsDir: path.join(tmp, 'skills') })
    const skill = await fs.readFile(path.join(tmp, 'skills', 'cwc-obs-flow', 'SKILL.md'), 'utf-8')
    expect(skill).not.toContain('## Run Logging')
    await fs.rm(tmp, { recursive: true })
  })
})

describe('exportWorkflow — rename reconciliation', () => {
  function soloCwc(id: string, name: string): CwcFile {
    const now = new Date().toISOString()
    return {
      meta: { id, name, description: '', version: 1, created: now, updated: now },
      nodes: [{ id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'Solo', description: '', completionCriteria: 'done' } }],
      edges: [{ id: 'e1', from: 'n1', to: null, trigger: 'Done.', terminalType: 'complete' }],
    }
  }

  it('removes the old workflow skill dir when the workflow is renamed and re-exported', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rename-exp-'))
    const skillsDir = path.join(tmp, 'skills')
    const target: ExportTarget = { type: 'user', userDir: tmp }

    // First export under the original name
    const first = await exportWorkflow(soloCwc('wf-r', 'Old Name'), target, { skillsDir })
    await fs.access(path.join(skillsDir, 'cwc-old-name', 'SKILL.md'))
    expect(first.updatedCwc.meta.exportedWorkflowSlug).toBe('cwc-old-name')

    // Rename and re-export, carrying the updated meta forward (as the app persists it)
    const renamed: CwcFile = { ...first.updatedCwc, meta: { ...first.updatedCwc.meta, name: 'New Name' } }
    await exportWorkflow(renamed, target, { skillsDir })

    await expect(fs.access(path.join(skillsDir, 'cwc-old-name'))).rejects.toThrow()  // old dir gone
    await fs.access(path.join(skillsDir, 'cwc-new-name', 'SKILL.md'))                // new dir present
    await fs.rm(tmp, { recursive: true })
  })

  it('does not delete an old-slug skill dir owned by a different workflow', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rename-foreign-'))
    const skillsDir = path.join(tmp, 'skills')
    const target: ExportTarget = { type: 'user', userDir: tmp }

    // A foreign workflow already owns skills/cwc-old-name/
    const foreignDir = path.join(skillsDir, 'cwc-old-name')
    await fs.mkdir(foreignDir, { recursive: true })
    await fs.writeFile(path.join(foreignDir, 'SKILL.md'), '# x\n<!-- cwc:workflow:other-wf -->\n')

    // Our workflow claims it was last exported as cwc-old-name, now renamed
    const cwc = soloCwc('wf-r', 'New Name')
    cwc.meta.exportedWorkflowSlug = 'cwc-old-name'
    await exportWorkflow(cwc, target, { skillsDir })

    // Foreign dir untouched; ours written
    const foreign = await fs.readFile(path.join(foreignDir, 'SKILL.md'), 'utf-8')
    expect(foreign).toContain('cwc:workflow:other-wf')
    await fs.access(path.join(skillsDir, 'cwc-new-name', 'SKILL.md'))
    await fs.rm(tmp, { recursive: true })
  })
})

describe('exportWorkflow — gate nodes', () => {
  it('writes no agent file for gate nodes and leaves their exportedSlug null', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-gate-exp-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'wf-g', name: 'Gate Flow', description: '', version: 1, created: now, updated: now },
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'Solo', description: '', completionCriteria: 'done' } },
        { id: 'g1', position: { x: 1, y: 0 }, exportedSlug: null, nodeType: 'gate', agent: { name: 'Check', description: '', completionCriteria: '' } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'g1', trigger: 'go' },
        { id: 'e2', from: 'g1', to: null, trigger: 'Done.', terminalType: 'complete' },
      ],
    }
    const { updatedCwc } = await exportWorkflow(cwc, { type: 'user', userDir: tmp }, { skillsDir: path.join(tmp, 'skills') })
    await expect(fs.access(path.join(tmp, '.claude', 'agents', 'check.md'))).rejects.toThrow()
    expect(updatedCwc.nodes.find(n => n.id === 'g1')!.exportedSlug).toBeNull()
    const skill = await fs.readFile(path.join(tmp, 'skills', 'cwc-gate-flow', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('Approval gate "Check"')
    await fs.rm(tmp, { recursive: true })
  })
})
