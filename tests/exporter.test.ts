import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exportWorkflow, ExportTarget } from '../src/exporter.js'
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
    path.join(import.meta.dirname, 'fixtures', name),
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
