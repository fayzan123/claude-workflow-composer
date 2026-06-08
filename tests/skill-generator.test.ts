import { describe, it, expect } from 'vitest'
import matter from 'gray-matter'
import {
  assembleSkillFile, parseSkillSpec, buildSkillSpecPrompt, buildSkillBuildPrompt,
  type SkillSpec,
} from '../src/skill-generator.js'

const SPEC: SkillSpec = {
  name: 'migration-reviewer',
  description: 'Use when reviewing SQL migrations for safety before they are applied.',
  steps: ['Read the migration file', 'Check for table locks', 'Flag non-reversible changes'],
}

describe('assembleSkillFile', () => {
  it('round-trips through gray-matter with name + description', () => {
    const body = '# Migration Reviewer\n\nReview SQL migrations.'
    const file = assembleSkillFile(SPEC, body)
    const { data, content } = matter(file)
    expect(data['name']).toBe('migration-reviewer')
    expect(data['description']).toBe(SPEC.description)
    expect(content.trim()).toBe(body.trim())
  })

  it('normalises the frontmatter name to a slug', () => {
    const file = assembleSkillFile({ ...SPEC, name: 'Migration Reviewer!!' }, 'body')
    expect(matter(file).data['name']).toBe('migration-reviewer')
  })

  it('contains no cwc workflow marker (standalone skill)', () => {
    expect(assembleSkillFile(SPEC, 'body')).not.toContain('cwc:workflow')
  })
})

describe('parseSkillSpec', () => {
  const raw = JSON.stringify({
    name: 'migration-reviewer',
    description: 'Use when reviewing migrations.',
    steps: ['Read it', 'Check locks'],
  })

  it('parses bare JSON', () => {
    expect(parseSkillSpec(raw).name).toBe('migration-reviewer')
  })

  it('parses JSON wrapped in fences with prose', () => {
    const spec = parseSkillSpec('Here:\n```json\n' + raw + '\n```\ndone')
    expect(spec.steps).toEqual(['Read it', 'Check locks'])
  })

  it('coerces missing steps to an empty array and trims fields', () => {
    const spec = parseSkillSpec('{"name":" x ","description":" d "}')
    expect(spec.name).toBe('x')
    expect(spec.description).toBe('d')
    expect(spec.steps).toEqual([])
  })

  it('throws when no JSON object is present', () => {
    expect(() => parseSkillSpec('no json here')).toThrow(/no spec/i)
  })
})

describe('skill prompt builders', () => {
  it('spec prompt embeds the message and demands JSON-only', () => {
    const p = buildSkillSpecPrompt('a skill that reviews migrations')
    expect(p).toContain('a skill that reviews migrations')
    expect(p).toMatch(/only.*JSON/i)
    expect(p).toContain('steps')
  })

  it('build prompt forbids frontmatter and generic filler', () => {
    const p = buildSkillBuildPrompt(SPEC)
    expect(p).toContain('migration-reviewer')
    expect(p).toMatch(/do not.*frontmatter/i)
    expect(p).toMatch(/helpful assistant/i)
  })
})
