// src/server/skill-catalog.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { CatalogSkill } from '../workflow-generator.js'

export type { CatalogSkill }

/** Marker written into CWC-exported workflow skills — never suggest reusing one. */
const CWC_WORKFLOW_MARKER = /<!-- cwc:workflow:[^:\s>]+ -->/

/**
 * List the user's own skills (~/.claude/skills/*\/SKILL.md) as reuse candidates for
 * workflow generation. Skips CWC-exported workflow skills (circular). Plugin skills are
 * intentionally excluded — the relevant reuse targets are skills the user authored.
 */
export async function listReusableSkills(userHomeDir: string): Promise<CatalogSkill[]> {
  const dir = path.join(userHomeDir, '.claude', 'skills')
  let slugs: string[]
  try { slugs = await fs.readdir(dir) } catch { return [] }
  const out: CatalogSkill[] = []
  for (const slug of slugs) {
    try {
      const raw = await fs.readFile(path.join(dir, slug, 'SKILL.md'), 'utf-8')
      if (CWC_WORKFLOW_MARKER.test(raw)) continue
      const { data } = matter(raw)
      out.push({ slug, description: String(data['description'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) })
    } catch { /* not a skill dir — skip */ }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
