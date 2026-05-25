import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'

export interface SkillResolution {
  slug: string
  description: string | null
  found: boolean
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readSkillDescription(skillMdPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    const { data } = matter(content)
    return typeof data.description === 'string' ? data.description : null
  } catch {
    return null
  }
}

export async function resolveSkill(slug: string): Promise<SkillResolution> {
  const home = process.env.HOME ?? ''

  if (slug.includes(':')) {
    const [pluginKey, skillSlug] = slug.split(':') as [string, string]
    // Look up installPath from installed_plugins.json
    const pluginsJsonPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json')
    try {
      const raw = await fs.readFile(pluginsJsonPath, 'utf-8')
      const installed = JSON.parse(raw) as Record<string, { installPath: string }>
      // Find plugin entry — key may be "pluginKey@publisher" or just "pluginKey"
      const entry = Object.entries(installed).find(([k]) => k === pluginKey || k.startsWith(`${pluginKey}@`))
      if (!entry) return { slug, description: null, found: false }
      const skillMdPath = path.join(entry[1].installPath, 'skills', skillSlug, 'SKILL.md')
      if (!(await fileExists(skillMdPath))) return { slug, description: null, found: false }
      const description = await readSkillDescription(skillMdPath)
      return { slug, description, found: true }
    } catch {
      return { slug, description: null, found: false }
    }
  }

  // Non-namespaced: ~/.claude/skills/<slug>/SKILL.md
  const skillMdPath = path.join(home, '.claude', 'skills', slug, 'SKILL.md')
  if (!(await fileExists(skillMdPath))) return { slug, description: null, found: false }
  const description = await readSkillDescription(skillMdPath)
  return { slug, description, found: true }
}
