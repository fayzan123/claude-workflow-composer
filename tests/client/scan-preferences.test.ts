import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SCAN_MODEL,
  SCAN_MODEL_STORAGE_KEY,
  parseScanModelPreference,
  readScanModel,
  writeScanModel,
} from '../../client/src/lib/scan-preferences.ts'

function storageWith(value: string | null): Pick<Storage, 'getItem' | 'setItem'> {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  }
}

describe('scan model preferences', () => {
  it('accepts only supported scan model keys', () => {
    expect(parseScanModelPreference('haiku')).toBe('haiku')
    expect(parseScanModelPreference('sonnet')).toBe('sonnet')
    expect(parseScanModelPreference('opus')).toBe('opus')
    expect(parseScanModelPreference('claude-sonnet-4-6')).toBeNull()
    expect(parseScanModelPreference(null)).toBeNull()
  })

  it('reads valid preferences and falls back to Sonnet for invalid or missing values', () => {
    expect(readScanModel(storageWith('opus'))).toBe('opus')
    expect(readScanModel(storageWith('unknown'))).toBe(DEFAULT_SCAN_MODEL)
    expect(readScanModel(storageWith(null))).toBe(DEFAULT_SCAN_MODEL)
    expect(readScanModel()).toBe(DEFAULT_SCAN_MODEL)
  })

  it('handles denied storage reads and writes without throwing', () => {
    const denied: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
    }

    expect(readScanModel(denied)).toBe(DEFAULT_SCAN_MODEL)
    expect(writeScanModel('haiku', denied)).toBe(false)
  })

  it('writes only validated preferences', () => {
    const storage = storageWith(null)

    expect(writeScanModel('haiku', storage)).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(SCAN_MODEL_STORAGE_KEY, 'haiku')

    vi.mocked(storage.setItem).mockClear()
    expect(writeScanModel('invalid', storage)).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
