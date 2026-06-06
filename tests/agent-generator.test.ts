import { describe, it, expect } from 'vitest'
import matter from 'gray-matter'
import { assembleAgentFile, type AgentSpec } from '../src/agent-generator.js'

const SPEC: AgentSpec = {
  name: 'Migration Reviewer',
  description: 'Audits SQL migrations for safety before they are applied.',
  whenToUse: 'Before applying any database migration.',
  suggestedTools: ['Read', 'Bash'],
  suggestedColor: 'red',
  keyBehaviors: ['Checks for table locks', 'Flags non-reversible changes'],
}

describe('assembleAgentFile', () => {
  it('produces frontmatter + body that round-trips through gray-matter', () => {
    const body = '# Migration Reviewer\n\nYou are **Migration Reviewer**, a careful DBA.'
    const file = assembleAgentFile(SPEC, body)
    const { data, content } = matter(file)
    expect(data['name']).toBe('Migration Reviewer')
    expect(data['description']).toBe(SPEC.description)
    expect(data['color']).toBe('red')
    expect(data['tools']).toBe('Read, Bash')
    expect(content.trim()).toBe(body.trim())
  })

  it('quotes a name containing a colon so YAML stays valid', () => {
    const spec = { ...SPEC, name: 'Reviewer: SQL' }
    const file = assembleAgentFile(spec, 'body')
    const { data } = matter(file)
    expect(data['name']).toBe('Reviewer: SQL')
  })

  it('omits tools line when suggestedTools is empty', () => {
    const spec = { ...SPEC, suggestedTools: [] }
    const file = assembleAgentFile(spec, 'body')
    expect(matter(file).data).not.toHaveProperty('tools')
  })

  it('omits color line when suggestedColor is empty', () => {
    const spec = { ...SPEC, suggestedColor: '' }
    const file = assembleAgentFile(spec, 'body')
    expect(matter(file).data).not.toHaveProperty('color')
  })

  it('contains no cwc ownership comment (standalone agent)', () => {
    const file = assembleAgentFile(SPEC, 'body')
    expect(file).not.toContain('cwc:node')
  })
})
