import { describe, expect, it } from 'vitest'
import {
  deriveScanUiState,
  detectResultsContent,
  homeScanActionPath,
  homeScanContent,
} from '../../client/src/lib/scan-state.ts'

describe('scan UI state', () => {
  it('keeps an active scan as a view action instead of starting another scan', () => {
    const state = deriveScanUiState('running', [])

    expect(state.kind).toBe('running')
    const content = homeScanContent(state)
    expect(content).toMatchObject({
      primary: { kind: 'view', label: 'View active scan' },
    })
    expect(homeScanActionPath(content.primary.kind)).toBe('/detect')
    expect(content.secondary).toBeUndefined()
  })

  it('separates reviewing results from scanning again', () => {
    const state = deriveScanUiState('done', [{ confidence: 0.82 }])
    const content = homeScanContent(state)

    expect(state).toEqual({ kind: 'results', candidateCount: 1, strongCandidateCount: 1 })
    expect(content.primary).toEqual({ kind: 'view', label: 'Review automations' })
    expect(content.secondary).toEqual({ kind: 'start', label: 'Scan again' })
    expect(homeScanActionPath(content.secondary.kind)).toBe('/detect?autostart=1')
  })

  it('surfaces lower-confidence candidates for review', () => {
    const state = deriveScanUiState('done', [{ confidence: 0.59 }, { confidence: 0.25 }])

    expect(state).toEqual({ kind: 'low-confidence', candidateCount: 2, strongCandidateCount: 0 })
    expect(homeScanContent(state).primary).toEqual({ kind: 'view', label: 'Review latest scan' })
    expect(detectResultsContent(state)).toMatchObject({
      title: '2 potential patterns found',
      detail: expect.stringContaining('weaker evidence'),
    })
  })

  it('keeps a completed empty scan reviewable', () => {
    const state = deriveScanUiState('done', [])
    const content = homeScanContent(state)

    expect(state.kind).toBe('empty')
    expect(content.primary).toEqual({ kind: 'view', label: 'View latest scan' })
    expect(content.secondary).toEqual({ kind: 'start', label: 'Scan again' })
    expect(detectResultsContent(state).emptyTitle).toBe('No strong patterns found')
  })

  it('describes a failed scan instead of presenting an initial empty state', () => {
    const state = deriveScanUiState('error', [])

    expect(state.kind).toBe('error')
    expect(homeScanContent(state).primary).toEqual({ kind: 'view', label: 'Review failed scan' })
    expect(homeScanContent(state).secondary).toEqual({ kind: 'start', label: 'Try again' })
    expect(detectResultsContent(state).emptyTitle).toBe('History scan failed')
  })

  it('starts a scan only when there is no persisted scan to review', () => {
    const state = deriveScanUiState('idle', [])

    expect(state.kind).toBe('initial')
    const content = homeScanContent(state)
    expect(content).toMatchObject({
      primary: { kind: 'start', label: 'Scan my history' },
    })
    expect(content.secondary).toBeUndefined()
  })
})
