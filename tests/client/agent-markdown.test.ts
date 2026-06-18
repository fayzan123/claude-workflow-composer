import { describe, it, expect } from 'vitest'
import { agentToMarkdown, parseAgentMarkdown } from '../../client/src/lib/agentMarkdown.ts'

describe('agent markdown round-trip', () => {
  it('serializes and parses back to the same authored fields', () => {
    const agent = {
      name: 'Test Gatekeeper',
      description: 'runs tests: blocks release on failure',   // colon → must survive
      tools: ['Bash', 'Read', 'Grep'],
      model: 'claude-sonnet-4-6',
      color: 'orange',
      systemPrompt: 'You are the gatekeeper.\n\n## Steps\n- run tests\n- block on failure',
    }
    const r = parseAgentMarkdown(agentToMarkdown(agent))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch).toEqual(agent)
  })

  it('preserves a horizontal rule (---) inside the system prompt body', () => {
    const md = agentToMarkdown({ name: 'A', description: 'd', systemPrompt: 'before\n\n---\n\nafter' })
    const r = parseAgentMarkdown(md)
    expect(r.ok && r.patch.systemPrompt).toBe('before\n\n---\n\nafter')
  })

  it('omits optional fields when absent and parses them as empty/undefined', () => {
    const md = agentToMarkdown({ name: 'A', description: 'd', systemPrompt: 'body' })
    expect(md).not.toContain('tools:')
    expect(md).not.toContain('model:')
    const r = parseAgentMarkdown(md)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.tools).toEqual([])
    expect(r.patch.model).toBeUndefined()
    expect(r.patch.color).toBeUndefined()
  })

  it('errors on missing frontmatter or missing name', () => {
    expect(parseAgentMarkdown('just a body, no frontmatter').ok).toBe(false)
    expect(parseAgentMarkdown('---\ndescription: x\n---\nbody').ok).toBe(false)
  })
})
