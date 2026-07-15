import { describe, it, expect } from 'vitest'
import {
  newTrigger,
  normalizeMaxRunsPerDay,
  normalizeTriggerForSave,
  validateTriggerForSave,
} from '../../client/src/lib/trigger.ts'
import { isAbsolutePath } from '../../client/src/lib/path.ts'

describe('trigger helpers', () => {
  it('recognizes POSIX and Windows absolute paths', () => {
    expect(isAbsolutePath('/repo')).toBe(true)
    expect(isAbsolutePath('C:\\repo')).toBe(true)
    expect(isAbsolutePath('C:/repo')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('relative/repo')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })

  it('normalizes maxRunsPerDay to at least one', () => {
    expect(normalizeMaxRunsPerDay('')).toBe(10)
    expect(normalizeMaxRunsPerDay('', 4)).toBe(4)
    expect(normalizeMaxRunsPerDay('0')).toBe(1)
    expect(normalizeMaxRunsPerDay('-3')).toBe(1)
    expect(normalizeMaxRunsPerDay('2.9')).toBe(2)
  })

  it('normalizes and validates trigger drafts before save', () => {
    const trigger = {
      ...newTrigger('cron'),
      cwd: ' /repo ',
      targets: undefined,
      maxRunsPerDay: 0,
    }
    const saved = normalizeTriggerForSave(trigger, ' /other \n\nrelative ')

    expect(saved.cwd).toBe('/repo')
    expect(saved.targets).toEqual(['/other', 'relative'])
    expect(saved.maxRunsPerDay).toBe(1)
    expect(validateTriggerForSave(saved)).toBe('Additional target repos must use absolute paths.')
    expect(validateTriggerForSave({ ...saved, targets: ['/other'] })).toBeNull()
    expect(validateTriggerForSave({ ...saved, cwd: '' })).toBe('Working directory is required.')
  })
})
