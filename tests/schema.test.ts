import { describe, expect, it } from 'vitest'
import { artifactKindOf, artifactTierOf, CWC_FILE_VERSION, type CwcFile } from '../src/schema.js'

function artifact(meta: Partial<CwcFile['meta']> = {}): CwcFile {
  return {
    meta: {
      id: 'wf', name: 'Artifact', description: '', version: 1, created: '', updated: '', ...meta,
    },
    nodes: [],
    edges: [],
  }
}

describe('CWC artifact metadata', () => {
  it('declares version 2 for newly-created files', () => {
    expect(CWC_FILE_VERSION).toBe(2)
  })

  it('defaults absent kind and tier to the legacy workflow behavior', () => {
    const cwc = artifact()
    expect(artifactKindOf(cwc)).toBe('workflow')
    expect(artifactTierOf(cwc)).toBe('workflow')
  })

  it('defaults a managed skill without an explicit tier to skill', () => {
    expect(artifactTierOf(artifact({ artifactKind: 'skill' }))).toBe('skill')
  })

  it('rejects unknown runtime kind and tier values', () => {
    expect(() => artifactKindOf(artifact({ artifactKind: 'future' as never }))).toThrow(/unsupported artifact kind/i)
    expect(() => artifactTierOf(artifact({ artifactTier: 'future' as never }))).toThrow(/unsupported artifact tier/i)
  })

  it.each([
    [{ artifactKind: 'workflow' as const, artifactTier: 'skill' as const }, /workflow artifact cannot use the skill tier/i],
    [{ artifactKind: 'workflow' as const, artifactTier: 'loop' as const }, /workflow artifact cannot use the loop tier/i],
    [{ artifactKind: 'skill' as const, artifactTier: 'workflow' as const }, /skill artifact cannot use the workflow tier/i],
  ])('rejects inconsistent artifact kind/tier pairs', (meta, expected) => {
    expect(() => artifactTierOf(artifact(meta))).toThrow(expected)
  })
})
