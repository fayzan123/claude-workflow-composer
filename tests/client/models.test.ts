import { describe, it, expect } from 'vitest'
import { modelChipLabel, CLAUDE_MODELS } from '../../client/src/lib/models.ts'

describe('modelChipLabel', () => {
  it('returns "Opus" for claude-opus-4-8', () => {
    expect(modelChipLabel('claude-opus-4-8')).toBe('Opus')
  })

  it('returns "Sonnet" for claude-sonnet-4-6', () => {
    expect(modelChipLabel('claude-sonnet-4-6')).toBe('Sonnet')
  })

  it('returns "Haiku" for claude-haiku-4-5-20251001', () => {
    expect(modelChipLabel('claude-haiku-4-5-20251001')).toBe('Haiku')
  })

  it('returns second segment for unknown model IDs', () => {
    expect(modelChipLabel('claude-future-9-0')).toBe('future')
  })

  it('returns the full string when model ID has no hyphens', () => {
    expect(modelChipLabel('somemodel')).toBe('somemodel')
  })

  it('CLAUDE_MODELS has exactly three entries', () => {
    expect(CLAUDE_MODELS).toHaveLength(3)
  })
})
