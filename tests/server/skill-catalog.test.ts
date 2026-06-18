import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { listReusableSkills, selectRelevantSkills } from '../../src/server/skill-catalog.js'
import type { DetectedAutomation } from '../../src/detection/types.js'

let home: string
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-skillcat-')) })
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function writeSkill(slug: string, frontmatter: string, body = 'x'): Promise<void> {
  const dir = path.join(home, '.claude', 'skills', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
}

describe('listReusableSkills', () => {
  it('lists user skills with slug + description, sorted by slug', async () => {
    await writeSkill('brutal-product-analysis', 'name: Brutal\ndescription: Tear apart a product idea')
    await writeSkill('aaa-skill', 'name: A\ndescription: first')
    const skills = await listReusableSkills(home)
    expect(skills.map(s => s.slug)).toEqual(['aaa-skill', 'brutal-product-analysis'])
    expect(skills.find(s => s.slug === 'brutal-product-analysis')!.description).toBe('Tear apart a product idea')
  })

  it('skips CWC-exported workflow skills (circular)', async () => {
    await writeSkill('my-workflow', 'name: WF\ndescription: d', 'body\n<!-- cwc:workflow:abc123 -->')
    expect(await listReusableSkills(home)).toEqual([])
  })

  it('returns [] when there is no skills dir', async () => {
    expect(await listReusableSkills(home)).toEqual([])
  })

  it('includes plugin skills with a namespaced plugin:slug', async () => {
    const dir = path.join(home, '.claude', 'plugins', 'cache', 'official', 'superpowers', '6.0.2', 'skills', 'subagent-driven-development')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: SDD\ndescription: execute a plan with subagents\n---\nx\n')
    const skills = await listReusableSkills(home)
    expect(skills.map(s => s.slug)).toContain('superpowers:subagent-driven-development')
  })
})

describe('selectRelevantSkills', () => {
  const auto = (p: Partial<DetectedAutomation>): DetectedAutomation => ({
    id: 'i', title: '', description: '', steps: [], stepTokens: [],
    evidence: { count: 3, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: '' }, confidence: 0.9, status: 'new', ...p,
  })

  it('keeps skills whose slug/description overlaps the automation, drops the rest', () => {
    const skills = [
      { slug: 'superpowers:subagent-driven-development', description: 'execute a plan with subagents' },
      { slug: 'colorize', description: 'add color to a design' },
    ]
    const out = selectRelevantSkills(skills, auto({ title: 'Subagent driven development run', stepTokens: ['subagent', 'plan'] }))
    expect(out.map(s => s.slug)).toEqual(['superpowers:subagent-driven-development'])
  })

  it('returns [] when nothing is relevant', () => {
    expect(selectRelevantSkills([{ slug: 'colorize', description: 'add color' }], auto({ title: 'publish to npm' }))).toEqual([])
  })
})
