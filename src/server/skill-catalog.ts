// src/server/skill-catalog.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { CapabilityCard, CatalogAgent, CatalogSkill } from '../workflow-generator.js'
import type { DetectedAutomation } from '../detection/types.js'

export type { CapabilityCard, CatalogAgent, CatalogSkill }

/** Marker written into CWC-exported workflow skills — never suggest reusing one. */
const CWC_WORKFLOW_MARKER = /<!-- cwc:workflow:[^:\s>]+ -->/

function frontmatterDescription(raw: string): string {
  try { return String(matter(raw).data['description'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }
  catch { return '' }
}

function frontmatterName(raw: string, fallback: string): string {
  try { return String(matter(raw).data['name'] ?? fallback).replace(/\s+/g, ' ').trim() || fallback }
  catch { return fallback }
}

function bodyExcerpt(raw: string, maxChars: number): string {
  let body = ''
  try { body = matter(raw).content } catch { body = raw }
  return body
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars)
}

function inferSignals(raw: string): string[] {
  const text = raw.toLowerCase()
  const signals: string[] = []
  if (/\bend[- ]to[- ]end\b|complete workflow|full workflow|from start to finish|entire process/.test(text)) signals.push('end-to-end')
  if (/review|code review|requesting-code-review/.test(text)) signals.push('review')
  if (/verify|verification|test|lint|typecheck|quality gate/.test(text)) signals.push('verification')
  if (/finish|finishing-a-development-branch|commit|pull request|pr\b|merge/.test(text)) signals.push('branch-finish')
  if (/subagent|agent tool|delegate|orchestrat/.test(text)) signals.push('delegates-to-subagents')
  return [...new Set(signals)]
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
      out.push({ slug, name: frontmatterName(raw, slug), description: frontmatterDescription(raw), source: 'user', filePath: path.join(userDir, slug, 'SKILL.md') })
    } catch { /* not a skill dir */ }
  }

  // Plugin skills: cache/<publisher>/<plugin>/<version>/skills/<slug>/SKILL.md
  const pluginCache = path.join(userHomeDir, '.claude', 'plugins', 'cache')
  for (const publisher of await fs.readdir(pluginCache).catch(() => [] as string[])) {
    for (const plugin of await fs.readdir(path.join(pluginCache, publisher)).catch(() => [] as string[])) {
      const versions = await fs.readdir(path.join(pluginCache, publisher, plugin)).catch(() => [] as string[])
      const latest = versions.sort(compareVersions).at(-1)
      if (!latest) continue
      const skillsDir = path.join(pluginCache, publisher, plugin, latest, 'skills')
      for (const slug of await fs.readdir(skillsDir).catch(() => [] as string[])) {
        try {
          const raw = await fs.readFile(path.join(skillsDir, slug, 'SKILL.md'), 'utf-8')
          out.push({ slug: `${plugin}:${slug}`, name: frontmatterName(raw, slug), description: frontmatterDescription(raw), source: 'plugin', filePath: path.join(skillsDir, slug, 'SKILL.md') })
        } catch { /* skip */ }
      }
    }
  }

  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** List existing user agents that workflow generation may reuse via CwcNode.agentRef. */
export async function listReusableAgents(userHomeDir: string): Promise<CatalogAgent[]> {
  const out: CatalogAgent[] = []
  const agentsDir = path.join(userHomeDir, '.claude', 'agents')
  for (const file of await fs.readdir(agentsDir).catch(() => [] as string[])) {
    if (!file.endsWith('.md')) continue
    const filePath = path.join(agentsDir, file)
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const slug = file.replace(/\.md$/, '')
      const name = frontmatterName(raw, slug)
      const description = frontmatterDescription(raw)
      out.push({ slug, name, description, source: 'user', filePath })
    } catch { /* skip malformed/unreadable agents */ }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** Compare dotted version strings numerically (so 1.10.0 > 1.9.0, unlike a lexical sort). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10))
  const pb = b.split('.').map(n => parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b)
    if (x !== y) return x - y
  }
  return 0
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

/** Same relevance pass for existing agents; keeps generation from duplicating obvious roles. */
export function selectRelevantAgents(agents: CatalogAgent[], a: DetectedAutomation, limit = 20): CatalogAgent[] {
  const hay = new Set(tokenize([a.title, a.description, a.steps.join(' '), a.stepTokens.join(' ')].join(' ')))
  return agents
    .map(agent => {
      const toks = new Set([...tokenize(agent.slug.replace(/[:_-]/g, ' ')), ...tokenize(agent.name), ...tokenize(agent.description)])
      let score = 0
      for (const t of toks) if (hay.has(t)) score++
      return { agent, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.agent)
}

export async function buildCapabilityCards(args: {
  skills?: CatalogSkill[]
  agents?: CatalogAgent[]
  maxSkills?: number
  maxAgents?: number
  maxCharsPerCard?: number
}): Promise<CapabilityCard[]> {
  const maxSkills = args.maxSkills ?? 5
  const maxAgents = args.maxAgents ?? 5
  const maxCharsPerCard = args.maxCharsPerCard ?? 2200
  const cards: CapabilityCard[] = []

  for (const skill of (args.skills ?? []).slice(0, maxSkills)) {
    if (!skill.filePath) continue
    try {
      const raw = await fs.readFile(skill.filePath, 'utf-8')
      if (CWC_WORKFLOW_MARKER.test(raw)) continue
      cards.push({
        kind: 'skill',
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        bodyExcerpt: bodyExcerpt(raw, maxCharsPerCard),
        signals: inferSignals(raw),
      })
    } catch { /* skip missing finalists */ }
  }

  for (const agent of (args.agents ?? []).slice(0, maxAgents)) {
    if (!agent.filePath) continue
    try {
      const raw = await fs.readFile(agent.filePath, 'utf-8')
      cards.push({
        kind: 'agent',
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        source: agent.source,
        bodyExcerpt: bodyExcerpt(raw, maxCharsPerCard),
        signals: inferSignals(raw),
      })
    } catch { /* skip missing finalists */ }
  }

  return cards
}
