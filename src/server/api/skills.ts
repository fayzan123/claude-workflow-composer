import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'

export interface SkillEntry {
  slug: string
  name: string
  description: string
  source: 'user' | 'plugin'
  namespacedSlug: string   // 'pluginName:slug' for plugins, plain slug for user skills
  filePath: string
}

export function skillsRouter(userHomeDir: string) {
  const router = createRouter()

  router.get('/', async (_req, res) => {
    const userSkillsDir = path.join(userHomeDir, '.claude', 'skills')
    const pluginCacheDir = path.join(userHomeDir, '.claude', 'plugins', 'cache')

    const skills: SkillEntry[] = []

    const CWC_WORKFLOW_MARKER = /<!-- cwc:workflow:[^:\s>]+ -->/

    // User skills — each subdir of userSkillsDir is a skill slug
    try {
      const dirs = await fs.readdir(userSkillsDir)
      for (const slug of dirs) {
        const skillFile = path.join(userSkillsDir, slug, 'SKILL.md')
        try {
          const raw = await fs.readFile(skillFile, 'utf-8')
          if (CWC_WORKFLOW_MARKER.test(raw)) continue  // skip workflow-exported skills
          const { data } = matter(raw)
          skills.push({ slug, name: String(data['name'] ?? slug), description: String(data['description'] ?? ''), source: 'user', namespacedSlug: slug, filePath: skillFile })
        } catch { /* skip */ }
      }
    } catch { /* dir missing */ }

    // Plugin skills — walk cache/<publisher>/<plugin>/<version>/skills/
    try {
      const publishers = await fs.readdir(pluginCacheDir)
      for (const publisher of publishers) {
        const pluginNames = await fs.readdir(path.join(pluginCacheDir, publisher)).catch(() => [])
        for (const pluginName of pluginNames) {
          const versions = await fs.readdir(path.join(pluginCacheDir, publisher, pluginName)).catch(() => [])
          const latestVersion = versions.sort().at(-1)
          if (!latestVersion) continue
          const skillsDir = path.join(pluginCacheDir, publisher, pluginName, latestVersion, 'skills')
          const slugs = await fs.readdir(skillsDir).catch(() => [])
          for (const slug of slugs) {
            const skillFile = path.join(skillsDir, slug, 'SKILL.md')
            try {
              const { data } = matter(await fs.readFile(skillFile, 'utf-8'))
              skills.push({ slug, name: String(data['name'] ?? slug), description: String(data['description'] ?? ''), source: 'plugin', namespacedSlug: `${pluginName}:${slug}`, filePath: skillFile })
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* no plugins */ }

    res.json(skills)
  })

  router.post('/', async (req, res) => {
    const slug = req.body?.slug
    const content = req.body?.content
    const overwrite = req.body?.overwrite === true
    if (typeof slug !== 'string' || typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ error: 'slug and content are required' })
      return
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'invalid slug' })
      return
    }
    const dir = path.join(userHomeDir, '.claude', 'skills', slug)
    const filePath = path.join(dir, 'SKILL.md')
    try {
      if (!overwrite) {
        // No O_EXCL — ~/.claude/skills/ is a single-user dir, so the race is benign.
        try {
          await fs.access(filePath)
          res.status(409).json({ error: `A skill named "${slug}" already exists.` })
          return
        } catch { /* does not exist — proceed */ }
      }
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
      res.json({ slug, filePath })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/', async (req, res) => {
    const filePath = req.query['path'] as string | undefined
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' })
      return
    }
    const claudeDir = path.join(userHomeDir, '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }
    // Must be <...>/skills/<slug>/SKILL.md so we only ever remove a single skill dir.
    const skillDir = path.dirname(resolved)
    if (path.basename(resolved) !== 'SKILL.md' || path.basename(path.dirname(skillDir)) !== 'skills') {
      res.status(400).json({ error: 'not a skill directory' })
      return
    }
    try {
      await fs.access(resolved)
    } catch {
      res.status(404).json({ error: 'Skill not found' })
      return
    }
    try {
      await fs.rm(skillDir, { recursive: true, force: true })
      res.json({ deleted: true })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
