import type { CwcFile } from './schema.js'
import { artifactKindOf } from './schema.js'

/** Canonical shape of a deployed slug: lowercase alphanumerics separated by single
 * hyphens. Validators must import this rather than restating the pattern. */
export const CANONICAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/**
 * Slug for a bespoke agent's filename and `subagent_type`. Names made entirely
 * of characters that `slugify` strips (emoji, punctuation) would otherwise yield
 * an empty slug — and a `.md` file with no stem — so fall back to a safe default.
 */
export function agentSlug(name: string): string {
  return slugify(name) || 'agent'
}

/** Slug for a skill's directory and SKILL.md frontmatter name. Falls back to a safe
 * default when the name is made entirely of characters slugify strips. */
export function skillSlug(name: string): string {
  return slugify(name) || 'skill'
}

/** Slug for a workflow skill slash command and export directory. */
export function workflowSkillSlug(name: string): string {
  // Claude skill names are capped at 64 characters. Reserve the prefix and do
  // not leave a trailing separator when truncation lands on a word boundary.
  const base = slugify(name).slice(0, 60).replace(/-+$/g, '') || 'workflow'
  return `cwc-${base}`
}

/** Slug that a fresh export of this artifact should write. */
export function currentArtifactSkillSlug(cwc: CwcFile): string {
  if (artifactKindOf(cwc) === 'workflow') return workflowSkillSlug(cwc.meta.name)
  return skillSlug(cwc.nodes[0]?.agent.name ?? cwc.meta.name)
}

/** Slug an existing deployment uses; a rename takes effect only after re-export. */
export function deployedArtifactSkillSlug(cwc: CwcFile): string {
  return cwc.meta.exportedWorkflowSlug || currentArtifactSkillSlug(cwc)
}
