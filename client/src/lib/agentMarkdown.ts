// client/src/lib/agentMarkdown.ts
// Round-trip an agent's authored fields <-> a source .md document (frontmatter + system-prompt
// body), so a bespoke canvas agent can be read/edited as raw markdown. CWC-only fields
// (completionCriteria, skills, graph wiring) are NOT part of this document — they stay in the form.

export interface AgentFields {
  name?: string
  description?: string
  tools?: string[]
  model?: string
  color?: string
  systemPrompt?: string
}

export interface AgentMdPatch {
  name: string
  description: string
  tools: string[]
  model: string | undefined
  color: string | undefined
  systemPrompt: string
}

/** Quote a frontmatter scalar only when it needs it (colon, hash, leading/trailing space, quote, empty). */
function scalar(v: string): string {
  if (v === '' || /[:#]|^["'\s]|\s$/.test(v)) return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  return v
}
function unscalar(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return t
}

/** Serialize an agent's authored fields as a source .md (frontmatter + system-prompt body). */
export function agentToMarkdown(a: AgentFields): string {
  const fm = [`name: ${scalar(a.name ?? '')}`, `description: ${scalar(a.description ?? '')}`]
  if (a.tools && a.tools.length) fm.push(`tools: ${a.tools.join(', ')}`)
  if (a.model) fm.push(`model: ${scalar(a.model)}`)
  if (a.color) fm.push(`color: ${scalar(a.color)}`)
  return `---\n${fm.join('\n')}\n---\n\n${a.systemPrompt ?? ''}`
}

/** Parse the source .md back into authored fields, or report what's wrong. */
export function parseAgentMarkdown(md: string): { ok: true; patch: AgentMdPatch } | { ok: false; error: string } {
  const m = md.match(/^\s*---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { ok: false, error: 'Add a frontmatter block (--- … ---) at the top, with at least a name.' }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const name = unscalar(fm['name'] ?? '')
  if (!name) return { ok: false, error: 'Frontmatter must include a non-empty "name".' }
  return {
    ok: true,
    patch: {
      name,
      description: unscalar(fm['description'] ?? ''),
      tools: fm['tools'] ? fm['tools'].split(',').map(t => t.trim()).filter(Boolean) : [],
      model: fm['model'] ? unscalar(fm['model']) : undefined,
      color: fm['color'] ? unscalar(fm['color']) : undefined,
      systemPrompt: m[2].replace(/^\n+/, ''),
    },
  }
}
