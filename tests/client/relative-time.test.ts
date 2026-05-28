import { describe, it, expect } from 'vitest'
import { relativeTime } from '../../client/src/components/TemplatePicker.tsx'

const NOW = new Date('2026-05-26T12:00:00Z').getTime()

describe('relativeTime', () => {
  it('returns "just now" for < 60s ago', () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })
  it('returns "X min ago" for < 1hr ago', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago')
  })
  it('returns "X hr ago" for < 24hr ago', () => {
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3 hr ago')
  })
  it('returns "1 day ago" (singular) for exactly 1 day', () => {
    expect(relativeTime(new Date(NOW - 86400_000).toISOString(), NOW)).toBe('1 day ago')
  })
  it('returns "X days ago" for older', () => {
    expect(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2 days ago')
  })
})
