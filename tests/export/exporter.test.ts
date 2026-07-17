import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildExportPreview, ExportConflictError, exportWorkflow, ExportTarget } from '../../src/export/exporter.js'
import { CWC_FILE_VERSION, type CwcFile } from '../../src/schema.js'
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
    expect(data.name).toBe('cwc-linear-pipeline')
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
    expect(lines[lines.length - 2]).toBe('<!-- cwc:bespoke-agents:architect,developer,reviewer -->')
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

  it('rejects a reference agent that shares a dispatch slug with a bespoke agent', async () => {
    const cwc = await loadFixture('linear.cwc')
    cwc.nodes.push({
      id: 'ref-architect',
      position: { x: 0, y: 200 },
      exportedSlug: 'architect',
      agentRef: 'architect',
      agent: { name: 'Shared Architect', description: '', completionCriteria: '' },
    })

    await expect(exportWorkflow(cwc, { type: 'project', projectDir: tmpDir }, {
      skillsDir: path.join(tmpDir, 'skills'),
    })).rejects.toThrow(/same dispatch slug/i)
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

describe('exportWorkflow — managed skill artifacts', () => {
  function skillCwc(id = 'skill-wf', name = 'Migration Checker'): CwcFile {
    const now = new Date().toISOString()
    return {
      meta: {
        id,
        name,
        description: 'Check migrations safely.',
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
          description: 'Use when checking a migration before applying it.',
          completionCriteria: '',
          systemPrompt: '# Migration Checker\n\n1. Read the migration.\n2. Report unsafe operations.',
        },
      }],
      edges: [],
    }
  }

  it('writes one plain SKILL.md and no agent file or cwc-prefixed orchestrator', async () => {
    const cwc = skillCwc()
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const result = await exportWorkflow(cwc, target)
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md')

    expect(result.artifactKind).toBe('skill')
    expect(result.artifactSlug).toBe('migration-checker')
    expect(result.written).toEqual([skillPath])
    expect(result.updatedCwc.nodes[0].exportedSlug).toBeNull()
    await expect(fs.access(path.join(tmpDir, '.claude', 'agents'))).rejects.toThrow()
    await expect(fs.access(path.join(tmpDir, '.claude', 'skills', 'cwc-migration-checker'))).rejects.toThrow()

    const raw = await fs.readFile(skillPath, 'utf-8')
    const parsed = matter(raw)
    expect(parsed.data).toMatchObject({
      name: 'migration-checker',
      description: 'Use when checking a migration before applying it.',
      'disable-model-invocation': true,
    })
    expect(parsed.content).toContain('# Migration Checker')
    expect(raw.split('\n').filter(Boolean).at(-1)).toBe('<!-- cwc:workflow:skill-wf -->')
  })

  it('omits disable-model-invocation only when the skill explicitly opts into auto', async () => {
    const cwc = skillCwc()
    cwc.meta.modelInvocation = 'auto'
    await exportWorkflow(cwc, { type: 'project', projectDir: tmpDir })
    const raw = await fs.readFile(path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md'), 'utf-8')
    expect(matter(raw).data).not.toHaveProperty('disable-model-invocation')
  })

  it.each([
    ['no nodes', (cwc: CwcFile) => { cwc.nodes = [] }],
    ['multiple nodes', (cwc: CwcFile) => { cwc.nodes.push({ ...cwc.nodes[0], id: 'another' }) }],
    ['an edge', (cwc: CwcFile) => { cwc.edges = [{ id: 'e', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }] }],
    ['a gate node', (cwc: CwcFile) => { cwc.nodes[0].nodeType = 'gate' }],
    ['a reference node', (cwc: CwcFile) => { cwc.nodes[0].agentRef = 'existing-agent' }],
    ['no description', (cwc: CwcFile) => { cwc.nodes[0].agent.description = '' }],
    ['no body', (cwc: CwcFile) => { cwc.nodes[0].agent.systemPrompt = '' }],
  ])('rejects %s before creating export directories', async (_label, mutate) => {
    const cwc = skillCwc()
    mutate(cwc)
    await expect(exportWorkflow(cwc, { type: 'project', projectDir: tmpDir })).rejects.toThrow(/skill artifact/i)
    await expect(fs.access(path.join(tmpDir, '.claude'))).rejects.toThrow()
  })

  it('graduates a skill by replacing its owned plain skill with orchestrator and agent files', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('graduate-me'), target)
    const workflow: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, artifactKind: 'workflow', artifactTier: 'workflow' },
      edges: [{ id: 'done', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }],
    }

    const result = await exportWorkflow(workflow, target)

    await expect(fs.access(path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md'))).rejects.toThrow()
    await fs.access(path.join(tmpDir, '.claude', 'skills', 'cwc-migration-checker', 'SKILL.md'))
    await fs.access(path.join(tmpDir, '.claude', 'agents', 'migration-checker.md'))
    expect(result.deleted).toContain(path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md'))
  })

  it('demotes a one-node workflow by removing its owned orchestrator and agent', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const workflow = skillCwc('demote-me')
    workflow.meta.artifactKind = 'workflow'
    workflow.meta.artifactTier = 'workflow'
    workflow.edges = [{ id: 'done', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }]
    const first = await exportWorkflow(workflow, target)
    const skill: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, artifactKind: 'skill', artifactTier: 'skill' },
      edges: [],
    }

    const result = await exportWorkflow(skill, target)

    await expect(fs.access(path.join(tmpDir, '.claude', 'skills', 'cwc-migration-checker', 'SKILL.md'))).rejects.toThrow()
    await expect(fs.access(path.join(tmpDir, '.claude', 'agents', 'migration-checker.md'))).rejects.toThrow()
    await fs.access(path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md'))
    expect(result.updatedCwc.nodes[0].exportedSlug).toBeNull()
  })

  it('cleans an owned agent retained after its node left the recipe', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skill = skillCwc('removed-agent-cleanup')
    skill.meta.pendingExportCleanup = { agentSlugs: ['removed-worker'] }
    const agentPath = path.join(tmpDir, '.claude', 'agents', 'removed-worker.md')
    await fs.mkdir(path.dirname(agentPath), { recursive: true })
    await fs.writeFile(
      agentPath,
      '---\nname: removed-worker\n---\n\nOld instructions.\n<!-- cwc:node:removed:workflow:removed-agent-cleanup -->\n',
    )

    const preview = await buildExportPreview(skill, target)
    expect(preview.deletions).toContain(agentPath)
    const result = await exportWorkflow(skill, target)

    expect(result.deleted).toContain(agentPath)
    expect(result.updatedCwc.meta.pendingExportCleanup).toBeUndefined()
    await expect(fs.access(agentPath)).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('commits the new runnable skill identity when obsolete agent cleanup is blocked', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const workflow = skillCwc('partial-demotion')
    workflow.meta.artifactKind = 'workflow'
    workflow.meta.artifactTier = 'workflow'
    workflow.edges = [{ id: 'done', from: 'skill-node', to: null, trigger: 'done', terminalType: 'complete' }]
    const first = await exportWorkflow(workflow, target)
    const oldAgentPath = path.join(tmpDir, '.claude', 'agents', 'migration-checker.md')
    const external = path.join(tmpDir, 'foreign-agent.md')
    await fs.writeFile(external, 'foreign')
    await fs.unlink(oldAgentPath)
    await fs.symlink(external, oldAgentPath)
    const skill: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, artifactKind: 'skill', artifactTier: 'skill' },
      edges: [],
    }

    const result = await exportWorkflow(skill, target)

    expect(result.updatedCwc.meta.exportedWorkflowSlug).toBe('migration-checker')
    expect(result.updatedCwc.nodes[0].exportedSlug).toBe('migration-checker')
    await fs.access(path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md'))
    await expect(fs.access(path.join(tmpDir, '.claude', 'skills', 'cwc-migration-checker', 'SKILL.md'))).rejects.toThrow()
    expect(await fs.readFile(external, 'utf-8')).toBe('foreign')
    expect(result.warnings.some(warning => warning.includes('later cleanup retry'))).toBe(true)
  })

  it('preflights a renamed destination conflict before removing the previous skill', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('preflight-me', 'Old Skill'), target)
    const foreignDir = path.join(tmpDir, '.claude', 'skills', 'new-skill')
    await fs.mkdir(foreignDir, { recursive: true })
    await fs.writeFile(path.join(foreignDir, 'SKILL.md'), '# foreign\n')
    const renamed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node => ({ ...node, agent: { ...node.agent, name: 'New Skill' } })),
    }

    await expect(exportWorkflow(renamed, target)).rejects.toBeInstanceOf(ExportConflictError)
    await fs.access(path.join(tmpDir, '.claude', 'skills', 'old-skill', 'SKILL.md'))
  })

  it('preview and export reject the same foreign destination without changing it', async () => {
    const cwc = skillCwc('foreign-preview')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '# hand-authored\n', 'utf-8')

    await expect(buildExportPreview(cwc, target)).rejects.toBeInstanceOf(ExportConflictError)
    expect(await fs.readFile(skillPath, 'utf-8')).toBe('# hand-authored\n')
    await expect(exportWorkflow(cwc, target)).rejects.toBeInstanceOf(ExportConflictError)
    expect(await fs.readFile(skillPath, 'utf-8')).toBe('# hand-authored\n')
  })

  it('preview and export refuse a non-regular destination', async () => {
    const cwc = skillCwc('non-regular-preview')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md')
    await fs.mkdir(skillPath, { recursive: true })

    await expect(buildExportPreview(cwc, target)).rejects.toThrow(/not a regular file/i)
    await expect(exportWorkflow(cwc, target)).rejects.toThrow(/not a regular file/i)
    expect(await fs.readdir(skillPath)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('preview and export refuse a symbolic-link artifact directory', async () => {
    const cwc = skillCwc('symlink-preview')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, '.claude', 'skills')
    const externalDir = path.join(tmpDir, 'external-skill')
    await fs.mkdir(skillsDir, { recursive: true })
    await fs.mkdir(externalDir)
    await fs.symlink(externalDir, path.join(skillsDir, 'migration-checker'))

    await expect(buildExportPreview(cwc, target)).rejects.toThrow(/symbolic-link export directory/i)
    await expect(exportWorkflow(cwc, target)).rejects.toThrow(/symbolic-link export directory/i)
    expect(await fs.readdir(externalDir)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('does not treat an unreadable existing file as absent', async () => {
    const cwc = skillCwc('unreadable-preview')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'migration-checker', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '# foreign but writable\n', { encoding: 'utf-8', mode: 0o200 })
    try {
      await expect(buildExportPreview(cwc, target)).rejects.toThrow(/could not verify ownership/i)
      await expect(exportWorkflow(cwc, target)).rejects.toThrow(/could not verify ownership/i)
    } finally {
      await fs.chmod(skillPath, 0o600)
    }
    expect(await fs.readFile(skillPath, 'utf-8')).toBe('# foreign but writable\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the new deployment identity while failed skill cleanup is retried separately', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('retry-cleanup', 'Old Skill'), target)
    const renamed: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, name: 'New Skill' },
      nodes: first.updatedCwc.nodes.map(node => ({ ...node, agent: { ...node.agent, name: 'New Skill' } })),
    }
    const oldDir = path.join(tmpDir, '.claude', 'skills', 'old-skill')
    await fs.chmod(oldDir, 0o555)
    let incomplete: Awaited<ReturnType<typeof exportWorkflow>> | undefined
    try {
      incomplete = await exportWorkflow(renamed, target)
      expect(incomplete.updatedCwc.meta.exportedWorkflowSlug).toBe('new-skill')
      expect(incomplete.updatedCwc.meta.pendingExportCleanup).toEqual({ skillSlugs: ['old-skill'] })
      expect(incomplete.warnings.some(warning => warning.includes('later cleanup retry'))).toBe(true)
      await fs.access(path.join(oldDir, 'SKILL.md'))

      const retryPreview = await buildExportPreview(incomplete.updatedCwc, target)
      expect(retryPreview.deletions).toContain(path.join(oldDir, 'SKILL.md'))
      await fs.access(path.join(oldDir, 'SKILL.md'))
    } finally {
      await fs.chmod(oldDir, 0o755)
    }

    const retried = await exportWorkflow(incomplete!.updatedCwc, target)
    expect(retried.updatedCwc.meta.exportedWorkflowSlug).toBe('new-skill')
    expect(retried.updatedCwc.meta.pendingExportCleanup).toBeUndefined()
    await expect(fs.access(path.join(oldDir, 'SKILL.md'))).rejects.toThrow()
  })

  it('migrates a legacy retained cleanup slug without mistaking it for the runnable output', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('legacy-cleanup', 'Old Skill'), target)
    const oldSkillPath = path.join(tmpDir, '.claude', 'skills', 'old-skill', 'SKILL.md')
    const newSkillPath = path.join(tmpDir, '.claude', 'skills', 'new-skill', 'SKILL.md')
    const renamed: CwcFile = {
      ...first.updatedCwc,
      meta: { ...first.updatedCwc.meta, name: 'New Skill' },
      nodes: first.updatedCwc.nodes.map(node => ({
        ...node,
        agent: { ...node.agent, name: 'New Skill' },
      })),
    }
    // Older builds could successfully write the new skill but persist the old
    // cleanup slug as exportedWorkflowSlug. Recreate that state without guessing
    // during normal rename-before-export behavior.
    await fs.mkdir(path.dirname(newSkillPath), { recursive: true })
    await fs.copyFile(oldSkillPath, newSkillPath)

    const preview = await buildExportPreview(renamed, target)
    expect(preview.artifactSlug).toBe('new-skill')
    expect(preview.deletions).toContain(oldSkillPath)
    const migrated = await exportWorkflow(renamed, target)

    expect(migrated.updatedCwc.meta.exportedWorkflowSlug).toBe('new-skill')
    expect(migrated.updatedCwc.meta.pendingExportCleanup).toBeUndefined()
    await expect(fs.access(oldSkillPath)).rejects.toThrow()
    await fs.access(newSkillPath)
  })

  it('serializes conflicting exports to one normalized target', async () => {
    const projectTarget: ExportTarget = { type: 'project', projectDir: tmpDir }
    const equivalentUserTarget: ExportTarget = { type: 'user', userDir: path.join(tmpDir, '.') }
    const first = skillCwc('lease-first', 'Shared Destination')
    const second = skillCwc('lease-second', 'Shared Destination')

    const results = await Promise.allSettled([
      exportWorkflow(first, projectTarget),
      exportWorkflow(second, equivalentUserTarget),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(ExportConflictError) })
    const raw = await fs.readFile(
      path.join(tmpDir, '.claude', 'skills', 'shared-destination', 'SKILL.md'),
      'utf-8',
    )
    expect(raw).toContain('<!-- cwc:workflow:lease-first -->')
    expect(raw).not.toContain('lease-second')
  })

  it.skipIf(process.platform === 'win32')('serializes conflicting exports through real and symlinked target aliases', async () => {
    const realProject = path.join(tmpDir, 'real-project')
    const aliasProject = path.join(tmpDir, 'alias-project')
    await fs.mkdir(realProject)
    await fs.symlink(realProject, aliasProject, 'dir')

    let releaseFirst!: () => void
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstStaged!: () => void
    const firstReachedStage = new Promise<void>(resolve => { firstStaged = resolve })
    const first = exportWorkflow(
      skillCwc('alias-first', 'Alias Collision'),
      { type: 'project', projectDir: realProject },
      { beforeAtomicRename: async () => { firstStaged(); await holdFirst } },
    )
    await firstReachedStage
    let secondStaged = false
    const second = exportWorkflow(
      skillCwc('alias-second', 'Alias Collision'),
      { type: 'project', projectDir: aliasProject },
      { beforeAtomicRename: async () => { secondStaged = true } },
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(secondStaged).toBe(false)
    releaseFirst()
    const results = await Promise.allSettled([
      first,
      second,
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.any(ExportConflictError),
    })
    const raw = await fs.readFile(
      path.join(realProject, '.claude', 'skills', 'alias-collision', 'SKILL.md'),
      'utf-8',
    )
    expect(raw).toContain('<!-- cwc:workflow:alias-first -->')
    expect(raw).not.toContain('alias-second')
  })

  it('preserves prior runnable bytes and removes its temp after a failed atomic replacement', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('atomic-replace', 'Atomic Skill'), target)
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'atomic-skill', 'SKILL.md')
    const priorBytes = await fs.readFile(skillPath, 'utf-8')
    const changed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node => ({
        ...node,
        agent: { ...node.agent, systemPrompt: '# Atomic Skill\n\nThis replacement must not become partial.' },
      })),
    }
    let tempPath = ''

    await expect(exportWorkflow(changed, target, {
      beforeAtomicRename: async (filePath, candidateTempPath) => {
        expect(filePath).toBe(skillPath)
        tempPath = candidateTempPath
        expect(await fs.readFile(candidateTempPath, 'utf-8')).toContain('must not become partial')
        throw new Error('injected atomic commit failure')
      },
    })).rejects.toThrow('injected atomic commit failure')

    expect(await fs.readFile(skillPath, 'utf-8')).toBe(priorBytes)
    expect(tempPath).not.toBe('')
    await expect(fs.access(tempPath)).rejects.toThrow()
  })

  it('rolls back every workflow file when a later deployment commit fails', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const cwc = await loadFixture('linear.cwc') as CwcFile
    const first = await exportWorkflow(cwc, target)
    const agentPath = path.join(tmpDir, '.claude', 'agents', 'architect.md')
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'cwc-linear-pipeline', 'SKILL.md')
    const priorAgent = await fs.readFile(agentPath, 'utf-8')
    const priorSkill = await fs.readFile(skillPath, 'utf-8')
    const changed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map((node, index) => index === 0
        ? { ...node, agent: { ...node.agent, systemPrompt: `${node.agent.systemPrompt ?? ''}\n\nNEW DEPLOYMENT BYTES` } }
        : node),
    }

    await expect(exportWorkflow(changed, target, {
      beforeDeploymentCommit: async filePath => {
        if (filePath === skillPath) throw new Error('injected later deployment failure')
      },
    })).rejects.toThrow('injected later deployment failure')

    expect(await fs.readFile(agentPath, 'utf-8')).toBe(priorAgent)
    expect(await fs.readFile(skillPath, 'utf-8')).toBe(priorSkill)
    const agentEntries = await fs.readdir(path.dirname(agentPath))
    const skillEntries = await fs.readdir(path.dirname(skillPath))
    expect([...agentEntries, ...skillEntries].some(name => /\.cwc-.*\.(?:tmp|bak)$/.test(name))).toBe(false)
  })

  it('rolls back new bytes and obsolete cleanup when recipe authority does not commit', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('recipe-cas-rollback', 'Old Authority Skill'), target)
    const oldSkillPath = path.join(tmpDir, '.claude', 'skills', 'old-authority-skill', 'SKILL.md')
    const oldBytes = await fs.readFile(oldSkillPath, 'utf-8')
    const renamed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node => ({
        ...node,
        agent: {
          ...node.agent,
          name: 'New Authority Skill',
          systemPrompt: '# New Authority Skill\n\nThese bytes require matching recipe authority.',
        },
      })),
    }
    const newSkillPath = path.join(tmpDir, '.claude', 'skills', 'new-authority-skill', 'SKILL.md')

    await expect(exportWorkflow(renamed, target, {
      commitUpdatedCwc: async () => {
        throw new Error('injected recipe CAS conflict')
      },
    })).rejects.toThrow('injected recipe CAS conflict')

    expect(await fs.readFile(oldSkillPath, 'utf-8')).toBe(oldBytes)
    await expect(fs.access(newSkillPath)).rejects.toThrow()
    const skillsDir = path.join(tmpDir, '.claude', 'skills')
    const rootEntries = await fs.readdir(skillsDir)
    const oldEntries = await fs.readdir(path.dirname(oldSkillPath))
    expect([...rootEntries, ...oldEntries].some(name => /\.cwc-.*\.(?:tmp|bak)$/.test(name))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('preserves an owned destination mode across atomic replacement', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('atomic-mode', 'Mode Skill'), target)
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'mode-skill', 'SKILL.md')
    await fs.chmod(skillPath, 0o640)
    const changed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node => ({
        ...node,
        agent: { ...node.agent, systemPrompt: '# Mode Skill\n\nUpdated safely.' },
      })),
    }

    await exportWorkflow(changed, target)

    expect((await fs.stat(skillPath)).mode & 0o777).toBe(0o640)
  })

  it('removes an obsolete owned SKILL.md but preserves user-added files in its directory', async () => {
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const first = await exportWorkflow(skillCwc('assets-me', 'Old Skill'), target)
    const oldDir = path.join(tmpDir, '.claude', 'skills', 'old-skill')
    await fs.writeFile(path.join(oldDir, 'notes.md'), 'keep me')
    const renamed: CwcFile = {
      ...first.updatedCwc,
      nodes: first.updatedCwc.nodes.map(node => ({ ...node, agent: { ...node.agent, name: 'New Skill' } })),
    }

    const result = await exportWorkflow(renamed, target)

    await expect(fs.access(path.join(oldDir, 'SKILL.md'))).rejects.toThrow()
    expect(await fs.readFile(path.join(oldDir, 'notes.md'), 'utf-8')).toBe('keep me')
    expect(result.warnings.some(warning => warning.includes('Preserved 1 unowned file'))).toBe(true)
  })
})
