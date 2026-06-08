import { it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createApp } from '../../src/server/index.js'
import http from 'node:http'
import type { SkillEntry } from '../../src/server/api/skills.js'

let server: http.Server
let tmpHome: string
let port: number

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-skills-'))
  const skillDir = path.join(tmpHome, '.claude', 'skills', 'my-skill')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: My Skill\ndescription: Does something useful\n---\nSkill body.', 'utf-8')

  const app = createApp({ staticDir: null, userHomeDir: tmpHome })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpHome, { recursive: true })
})

it('GET /api/skills returns user skills', async () => {
  const res = await fetch(`http://localhost:${port}/api/skills`)
  expect(res.status).toBe(200)
  const skills = await res.json() as SkillEntry[]
  const found = skills.find((s) => s.slug === 'my-skill')
  expect(found).toBeDefined()
  expect(found!.name).toBe('My Skill')
  expect(found!.source).toBe('user')
  expect(found!.namespacedSlug).toBe('my-skill')
})

it('GET /api/skills returns empty array when skills dir missing', async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-empty-home-'))
  const emptyApp = createApp({ staticDir: null, userHomeDir: emptyHome })
  const emptyServer = await new Promise<http.Server>((resolve) => {
    const s = emptyApp.listen(0, () => resolve(s))
  })
  const emptyPort = (emptyServer.address() as { port: number }).port
  const res = await fetch(`http://localhost:${emptyPort}/api/skills`)
  expect(await res.json()).toEqual([])
  await new Promise<void>((r) => emptyServer.close(() => r()))
  await fs.rm(emptyHome, { recursive: true })
})

async function postSkill(body: unknown) {
  const res = await fetch(`http://localhost:${port}/api/skills`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as any }
}

it('POST /api/skills writes <slug>/SKILL.md and returns the slug', async () => {
  const content = '---\nname: migration-reviewer\ndescription: d\n---\nReview migrations.'
  const { status, json } = await postSkill({ slug: 'migration-reviewer', content })
  expect(status).toBe(200)
  expect(json.slug).toBe('migration-reviewer')
  const written = await fs.readFile(path.join(tmpHome, '.claude', 'skills', 'migration-reviewer', 'SKILL.md'), 'utf-8')
  expect(written).toContain('name: migration-reviewer')
})

it('POST /api/skills returns 409 when the slug exists without overwrite', async () => {
  const content = '---\nname: dup\ndescription: d\n---\nbody'
  await postSkill({ slug: 'dup-skill', content })
  const { status, json } = await postSkill({ slug: 'dup-skill', content })
  expect(status).toBe(409)
  expect(json.error).toMatch(/exists/i)
})

it('POST /api/skills overwrites when overwrite:true', async () => {
  await postSkill({ slug: 'over-skill', content: '---\nname: over\ndescription: v1\n---\nb' })
  const { status } = await postSkill({ slug: 'over-skill', content: '---\nname: over\ndescription: v2\n---\nb', overwrite: true })
  expect(status).toBe(200)
  const written = await fs.readFile(path.join(tmpHome, '.claude', 'skills', 'over-skill', 'SKILL.md'), 'utf-8')
  expect(written).toContain('v2')
})

it('POST /api/skills rejects a traversal slug', async () => {
  const { status } = await postSkill({ slug: '../evil', content: '---\nname: x\ndescription: y\n---\nb' })
  expect(status).toBe(400)
})
