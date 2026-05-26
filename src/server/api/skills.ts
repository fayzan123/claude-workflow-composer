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

    // User skills — each subdir of userSkillsDir is a skill slug
    try {
      const dirs = await fs.readdir(userSkillsDir)
      for (const slug of dirs) {
        const skillFile = path.join(userSkillsDir, slug, 'SKILL.md')
        try {
          const { data } = matter(await fs.readFile(skillFile, 'utf-8'))
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

  return router
}
