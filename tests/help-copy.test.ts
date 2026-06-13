import { describe, it, expect } from 'vitest'
import { getTerm, getControlHint } from '../client/src/lib/help-copy.js'

describe('help-copy glossary', () => {
  it('returns a definition for a known term, case-insensitively', () => {
    expect(getTerm('Gate')).toMatch(/pause/i)
    expect(getTerm('gate')).toBe(getTerm('GATE'))
  })

  it('returns null for an unknown term', () => {
    expect(getTerm('flux capacitor')).toBeNull()
  })

  it('returns a hint string for a known control id', () => {
    expect(getControlHint('edge.trigger')).toMatch(/handoff/i)
  })

  it('returns empty string for an unknown control id', () => {
    expect(getControlHint('node.nonexistent')).toBe('')
  })
})
