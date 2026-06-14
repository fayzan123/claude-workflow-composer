import { describe, it, expect } from 'vitest'
import { relativeTime } from '../../client/src/views/HomeDashboard.tsx'

const NOW = new Date('2026-05-26T12:00:00Z').getTime()

describe('relativeTime', () => {
  it('returns "just now" for < 60s ago', () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })
  it('returns "Xm ago" for < 1hr ago', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago')
  })
  it('returns "Xh ago" for < 24hr ago', () => {
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h ago')
  })
  it('returns "Xd ago" for >= 1 day', () => {
    expect(relativeTime(new Date(NOW - 86400_000).toISOString(), NOW)).toBe('1d ago')
    expect(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2d ago')
  })
})
