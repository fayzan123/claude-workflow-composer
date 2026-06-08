export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
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
