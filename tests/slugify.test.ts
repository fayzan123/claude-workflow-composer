import { describe, it, expect } from 'vitest'
import { slugify, agentSlug } from '../src/slugify.js'

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Backend Architect')).toBe('backend-architect')
  })

  it('replaces underscores with hyphens', () => {
    expect(slugify('my_agent')).toBe('my-agent')
  })

  it('strips non-alphanumeric characters except hyphens', () => {
    expect(slugify('Auth & Security')).toBe('auth-security')
  })

  it('truncates at 64 characters', () => {
    const long = 'a'.repeat(70)
    expect(slugify(long)).toHaveLength(64)
  })

  it('collapses multiple hyphens', () => {
    expect(slugify('A -- B')).toBe('a-b')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--backend--')).toBe('backend')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
})

describe('agentSlug', () => {
  it('slugifies normal names', () => {
    expect(agentSlug('Backend Architect')).toBe('backend-architect')
  })

  it('falls back to "agent" when name has no slug-able characters', () => {
    expect(agentSlug('🎉')).toBe('agent')
    expect(agentSlug('---')).toBe('agent')
    expect(agentSlug('')).toBe('agent')
  })
})
