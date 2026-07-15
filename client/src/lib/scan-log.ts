export interface ScanLogEntry {
  ts: string
  level: string
  message: string
}

function logKey(entry: ScanLogEntry): string {
  return `${entry.ts}\0${entry.level}\0${entry.message}`
}

function compareLogs(a: ScanLogEntry, b: ScanLogEntry): number {
  const aTime = Date.parse(a.ts)
  const bTime = Date.parse(b.ts)
  const aValid = Number.isFinite(aTime)
  const bValid = Number.isFinite(bTime)

  if (aValid && bValid && aTime !== bTime) return aTime - bTime
  if (aValid !== bValid) return aValid ? -1 : 1

  const aKey = logKey(a)
  const bKey = logKey(b)
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}

/**
 * Reconciles persisted GET logs with live SSE logs. The first copy of an entry wins,
 * preserving any extra fields on the already-rendered object.
 */
export function mergeScanLogs<T extends ScanLogEntry>(previous: T[], incoming: readonly T[]): T[] {
  const unique = new Map<string, T>()
  for (const entry of previous) unique.set(logKey(entry), entry)
  for (const entry of incoming) {
    const key = logKey(entry)
    if (!unique.has(key)) unique.set(key, entry)
  }

  const merged = [...unique.values()].sort(compareLogs)
  const unchanged = merged.length === previous.length
    && merged.every((entry, index) => entry === previous[index])

  return unchanged ? previous : merged
}
