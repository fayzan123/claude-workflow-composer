import { describe, it, expect } from 'vitest'
import matter from 'gray-matter'
import { assembleAgentFile, type AgentSpec, parseSpec, buildSpecPrompt, buildBuildPrompt } from '../../src/generation/agent-generator.js'

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

describe('parseSpec', () => {
  const raw = JSON.stringify({
    name: 'Migration Reviewer',
    description: 'Audits SQL migrations.',
    whenToUse: 'Before applying migrations.',
    suggestedTools: ['Read', 'Bash', 'NotARealTool'],
    suggestedColor: 'red',
    keyBehaviors: ['Checks locks'],
  })

  it('parses a bare JSON object', () => {
    const spec = parseSpec(raw)
    expect(spec.name).toBe('Migration Reviewer')
  })

  it('parses JSON wrapped in markdown fences with surrounding prose', () => {
    const spec = parseSpec("Here is the spec:\n```json\n" + raw + "\n```\nDone.")
    expect(spec.description).toBe('Audits SQL migrations.')
  })

  it('drops tool names outside the valid CWC tool set', () => {
    const spec = parseSpec(raw)
    expect(spec.suggestedTools).toEqual(['Read', 'Bash'])
  })

  it('falls back to "blue" for an invalid color', () => {
    const spec = parseSpec(JSON.stringify({ name: 'X', description: 'y', suggestedColor: 'chartreuse' }))
    expect(spec.suggestedColor).toBe('blue')
  })

  it('throws a clear error when no JSON object is present', () => {
    expect(() => parseSpec('I could not produce a spec.')).toThrow(/no spec/i)
  })

  it('parses an object with a nested JSON object field', () => {
    const spec = parseSpec('{"name":"Foo","description":"d","meta":{"a":1},"keyBehaviors":["x"]}')
    expect(spec.name).toBe('Foo')
    expect(spec.keyBehaviors).toEqual(['x'])
  })

  it('throws when a JSON object is present but malformed', () => {
    expect(() => parseSpec('{bad json}')).toThrow(/valid/i)
  })
})

describe('prompt builders', () => {
  it('spec prompt embeds the user message and demands JSON-only output', () => {
    const p = buildSpecPrompt('an agent that reviews my SQL migrations')
    expect(p).toContain('an agent that reviews my SQL migrations')
    expect(p).toMatch(/only.*JSON/i)
    expect(p).toContain('suggestedTools')
  })

  it('build prompt names the agent and forbids frontmatter + generic filler', () => {
    const p = buildBuildPrompt(SPEC)
    expect(p).toContain('Migration Reviewer')
    expect(p).toMatch(/do not.*frontmatter/i)
    expect(p).toMatch(/helpful assistant/i)
  })
})
