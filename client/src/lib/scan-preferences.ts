export type ScanModel = 'haiku' | 'sonnet' | 'opus'

export const SCAN_MODEL_STORAGE_KEY = 'cwc.scanModel'
export const DEFAULT_SCAN_MODEL: ScanModel = 'sonnet'

export function parseScanModelPreference(value: unknown): ScanModel | null {
  return value === 'haiku' || value === 'sonnet' || value === 'opus' ? value : null
}

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function readScanModel(
  storage: Pick<Storage, 'getItem'> | undefined = browserStorage(),
): ScanModel {
  if (!storage) return DEFAULT_SCAN_MODEL
  try {
    return parseScanModelPreference(storage.getItem(SCAN_MODEL_STORAGE_KEY)) ?? DEFAULT_SCAN_MODEL
  } catch {
    return DEFAULT_SCAN_MODEL
  }
}

export function writeScanModel(
  model: unknown,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
): boolean {
  const preference = parseScanModelPreference(model)
  if (!preference || !storage) return false
  try {
    storage.setItem(SCAN_MODEL_STORAGE_KEY, preference)
    return true
  } catch {
    return false
  }
}
