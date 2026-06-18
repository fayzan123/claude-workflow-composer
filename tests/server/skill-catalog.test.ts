import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildCapabilityCards, listReusableAgents, listReusableSkills, selectRelevantAgents, selectRelevantSkills } from '../../src/server/skill-catalog.js'
import type { DetectedAutomation } from '../../src/detection/types.js'

let home: string
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-skillcat-')) })
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function writeSkill(slug: string, frontmatter: string, body = 'x'): Promise<void> {
  const dir = path.join(home, '.claude', 'skills', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
}

async function writeAgent(slug: string, frontmatter: string, body = 'x'): Promise<void> {
  const dir = path.join(home, '.claude', 'agents')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${slug}.md`), `---\n${frontmatter}\n---\n${body}\n`)
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

describe('listReusableAgents', () => {
  it('lists user agents with slug, name, description, and path', async () => {
    await writeAgent('code-reviewer', 'name: Code Reviewer\ndescription: reviews implementation diffs')
    const agents = await listReusableAgents(home)
    expect(agents).toHaveLength(1)
    expect(agents[0].slug).toBe('code-reviewer')
    expect(agents[0].name).toBe('Code Reviewer')
    expect(agents[0].description).toBe('reviews implementation diffs')
    expect(agents[0].filePath).toContain('code-reviewer.md')
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

describe('selectRelevantAgents', () => {
  const auto = (p: Partial<DetectedAutomation>): DetectedAutomation => ({
    id: 'i', title: '', description: '', steps: [], stepTokens: [],
    evidence: { count: 3, repos: [], sessionIds: [], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: '' }, confidence: 0.9, status: 'new', ...p,
  })

  it('keeps agents whose name/description overlaps the automation', () => {
    const agents = [
      { slug: 'code-reviewer', name: 'Code Reviewer', description: 'reviews implementation diffs' },
      { slug: 'designer', name: 'Designer', description: 'polishes layouts' },
    ]
    const out = selectRelevantAgents(agents, auto({ title: 'Review implementation diff', stepTokens: ['review'] }))
    expect(out.map(a => a.slug)).toEqual(['code-reviewer'])
  })
})

describe('buildCapabilityCards', () => {
  it('reads body excerpts only for supplied skill and agent finalists', async () => {
    await writeSkill(
      'subagent-driven-development',
      'name: Subagent Driven Development\ndescription: execute plans with subagents',
      'Implements a plan end to end, requests code review, verifies tests, and finishes the development branch.',
    )
    await writeSkill('ignored-skill', 'name: Ignored\ndescription: should not be read', 'SHOULD_NOT_APPEAR')
    await writeAgent('reviewer', 'name: Reviewer\ndescription: reviews code', 'Use this agent for focused code review.')
    const skills = await listReusableSkills(home)
    const agents = await listReusableAgents(home)

    const cards = await buildCapabilityCards({
      skills: skills.filter(s => s.slug === 'subagent-driven-development'),
      agents,
      maxCharsPerCard: 500,
    })

    expect(cards.map(c => `${c.kind}:${c.slug}`)).toEqual(['skill:subagent-driven-development', 'agent:reviewer'])
    expect(cards[0].bodyExcerpt).toContain('requests code review')
    expect(cards[0].signals).toEqual(expect.arrayContaining(['end-to-end', 'review', 'verification', 'branch-finish']))
    expect(cards.map(c => c.bodyExcerpt).join('\n')).not.toContain('SHOULD_NOT_APPEAR')
  })
})
