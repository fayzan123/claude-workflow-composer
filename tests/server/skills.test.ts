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
