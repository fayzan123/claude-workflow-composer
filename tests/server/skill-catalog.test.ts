import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { listReusableSkills } from '../../src/server/skill-catalog.js'

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
})
