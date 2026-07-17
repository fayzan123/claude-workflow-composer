import { CANONICAL_SLUG_RE as SKILL_SLUG_RE } from '../slugify.js'

const BESPOKE_AGENTS_RE = /^<!-- cwc:bespoke-agents:(-|[a-z0-9-]+(?:,[a-z0-9-]+)*) -->$/
const SUBAGENT_TYPE_RE = /subagent_type:\s*(["'])([^"'\r\n]+)\1/g
const MAX_DECLARED_AGENTS = 256

function canonicalSlugs(slugs: readonly string[]): string[] {
  const unique = [...new Set(slugs)]
  if (unique.length > MAX_DECLARED_AGENTS || unique.some(slug => !SKILL_SLUG_RE.test(slug))) {
    throw new Error('Cannot encode invalid bespoke agent deployment metadata.')
  }
  return unique.sort()
}

/** A CWC workflow skill declares which plain subagent dispatches are bespoke.
 * The declaration sits immediately before the final workflow ownership marker,
 * so managed runs can distinguish required owned files from external references. */
export function buildBespokeAgentDeclaration(slugs: readonly string[]): string {
  const canonical = canonicalSlugs(slugs)
  return `<!-- cwc:bespoke-agents:${canonical.length > 0 ? canonical.join(',') : '-'} -->`
}

/** Return null for legacy, misplaced, malformed, duplicate, or non-canonical
 * declarations. Only the penultimate non-blank line is deployment authority. */
export function parseBespokeAgentDeclaration(content: string): string[] | null {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  const match = lines.at(-2)?.match(BESPOKE_AGENTS_RE)
  if (!match) return null
  if (match[1] === '-') return []
  const slugs = match[1].split(',')
  if (slugs.length > MAX_DECLARED_AGENTS) return null
  const canonical = [...new Set(slugs)].sort()
  return canonical.length === slugs.length && canonical.every((slug, index) => slug === slugs[index])
    ? canonical
    : null
}

/** Extract every literal Agent-tool dispatch mentioned by generated prose. */
export function agentDispatchTypes(content: string): string[] {
  return [...new Set([...content.matchAll(SUBAGENT_TYPE_RE)].map(match => match[2]))].sort()
}

/** Extract only plain dispatch slugs that can be snapshotted into the run plugin. */
export function unqualifiedAgentDispatchSlugs(content: string): string[] {
  return agentDispatchTypes(content).filter(slug => SKILL_SLUG_RE.test(slug))
}

/** Namespaced or malformed dispatch types cannot currently be resolved to exact
 * bytes. Managed bypass-permissions runs must reject them rather than silently
 * falling back to a mutable installed plugin or built-in agent. */
export function unsupportedAgentDispatchTypes(content: string): string[] {
  return agentDispatchTypes(content).filter(slug => !SKILL_SLUG_RE.test(slug))
}
