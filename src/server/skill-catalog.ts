// src/server/skill-catalog.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { CatalogSkill } from '../workflow-generator.js'
import type { DetectedAutomation } from '../detection/types.js'

export type { CatalogSkill }

/** Marker written into CWC-exported workflow skills — never suggest reusing one. */
const CWC_WORKFLOW_MARKER = /<!-- cwc:workflow:[^:\s>]+ -->/

function frontmatterDescription(raw: string): string {
  try { return String(matter(raw).data['description'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }
  catch { return '' }
}

/**
 * List skills the generator can reuse: the user's own skills (~/.claude/skills, plain slug)
 * AND plugin skills (~/.claude/plugins/cache, namespaced `plugin:slug` so they invoke correctly).
 * Skips CWC-exported workflow skills (circular).
 */
export async function listReusableSkills(userHomeDir: string): Promise<CatalogSkill[]> {
  const out: CatalogSkill[] = []

  // User skills
  const userDir = path.join(userHomeDir, '.claude', 'skills')
  for (const slug of await fs.readdir(userDir).catch(() => [] as string[])) {
    try {
      const raw = await fs.readFile(path.join(userDir, slug, 'SKILL.md'), 'utf-8')
      if (CWC_WORKFLOW_MARKER.test(raw)) continue
      out.push({ slug, description: frontmatterDescription(raw) })
    } catch { /* not a skill dir */ }
  }

  // Plugin skills: cache/<publisher>/<plugin>/<version>/skills/<slug>/SKILL.md
  const pluginCache = path.join(userHomeDir, '.claude', 'plugins', 'cache')
  for (const publisher of await fs.readdir(pluginCache).catch(() => [] as string[])) {
    for (const plugin of await fs.readdir(path.join(pluginCache, publisher)).catch(() => [] as string[])) {
      const versions = await fs.readdir(path.join(pluginCache, publisher, plugin)).catch(() => [] as string[])
      const latest = versions.sort().at(-1)
      if (!latest) continue
      const skillsDir = path.join(pluginCache, publisher, plugin, latest, 'skills')
      for (const slug of await fs.readdir(skillsDir).catch(() => [] as string[])) {
        try {
          const raw = await fs.readFile(path.join(skillsDir, slug, 'SKILL.md'), 'utf-8')
          out.push({ slug: `${plugin}:${slug}`, description: frontmatterDescription(raw) })
        } catch { /* skip */ }
      }
    }
  }

  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 2)
}

/**
 * Narrow a (possibly large) skill catalog to the ones actually relevant to this automation,
 * by token overlap of each skill's slug+description with the automation's title/steps/tokens.
 * Bounds the generation prompt AND focuses the model on real reuse candidates.
 */
export function selectRelevantSkills(skills: CatalogSkill[], a: DetectedAutomation, limit = 30): CatalogSkill[] {
  const hay = new Set(tokenize([a.title, a.description, a.steps.join(' '), a.stepTokens.join(' ')].join(' ')))
  return skills
    .map(s => {
      const toks = new Set([...tokenize(s.slug.replace(/[:_-]/g, ' ')), ...tokenize(s.description)])
      let score = 0
      for (const t of toks) if (hay.has(t)) score++
      return { s, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.s)
}
