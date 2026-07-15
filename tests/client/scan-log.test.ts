import { describe, expect, it } from 'vitest'
import { mergeScanLogs, type ScanLogEntry } from '../../client/src/lib/scan-log.ts'

function log(ts: string, level: string, message: string): ScanLogEntry {
  return { ts, level, message }
}

describe('scan log reconciliation', () => {
  it('merges GET replay and SSE entries without duplicates', () => {
    const first = log('2026-07-14T12:00:00.000Z', 'info', 'Reading history')
    const second = log('2026-07-14T12:00:01.000Z', 'info', 'Analyzing tasks')

    expect(mergeScanLogs([first], [first, second, second])).toEqual([first, second])
  })

  it('sorts out-of-order entries chronologically with deterministic ties', () => {
    const later = log('2026-07-14T12:00:02.000Z', 'info', 'Later')
    const tiedB = log('2026-07-14T12:00:01.000Z', 'warn', 'B')
    const tiedA = log('2026-07-14T12:00:01.000Z', 'info', 'A')

    expect(mergeScanLogs([later], [tiedB, tiedA])).toEqual([tiedA, tiedB, later])
  })

  it('puts malformed timestamps after valid entries in stable key order', () => {
    const invalidB = log('not-a-date', 'warn', 'B')
    const invalidA = log('', 'info', 'A')
    const valid = log('2026-07-14T12:00:00.000Z', 'info', 'Valid')

    expect(mergeScanLogs([invalidB], [valid, invalidA])).toEqual([valid, invalidA, invalidB])
  })

  it('keeps the previous array when reconciliation changes nothing', () => {
    const entry = log('2026-07-14T12:00:00.000Z', 'info', 'Reading history')
    const previous = [entry]

    expect(mergeScanLogs(previous, [entry])).toBe(previous)
  })
})
