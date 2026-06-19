import { describe, expect, it } from 'vitest'
import { parseThemePreference, resolveThemePreference } from '../../client/src/lib/theme.ts'

describe('theme helpers', () => {
  it('accepts only supported theme preferences', () => {
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('sepia')).toBeNull()
    expect(parseThemePreference(null)).toBeNull()
  })

  it('resolves system preference from the supplied system theme', () => {
    expect(resolveThemePreference('system', 'dark')).toBe('dark')
    expect(resolveThemePreference('system', 'light')).toBe('light')
    expect(resolveThemePreference('dark', 'light')).toBe('dark')
    expect(resolveThemePreference('light', 'dark')).toBe('light')
  })
})
