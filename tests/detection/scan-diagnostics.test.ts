import { describe, it, expect } from 'vitest'
import { redact, envSnapshot, totalsOf, type FileParseStats } from '../../src/detection/scan-diagnostics.js'

describe('redact', () => {
  it('replaces every occurrence of the home dir with ~', () => {
    const home = '/Users/some+user (1)'
    const msg = `ENOENT: ${home}/.claude/projects and again ${home}/x`
    expect(redact(msg, home)).toBe('ENOENT: ~/.claude/projects and again ~/x')
  })

  it('replaces both separator spellings of a windows home dir', () => {
    const home = 'C:\\Users\\tester'
    const msg = 'read C:\\Users\\tester\\.claude failed; also C:/Users/tester/.claude'
    expect(redact(msg, home)).toBe('read ~\\.claude failed; also ~/.claude')
  })

  it('leaves text without the home dir untouched', () => {
    expect(redact('plain message', '/Users/tester')).toBe('plain message')
  })
})

describe('totalsOf', () => {
  it('sums counts and merges type counts across files', () => {
    const files: FileParseStats[] = [
      { file: '~/a.jsonl', bytes: 10, lines: 5, units: 2, jsonErrors: 1, typeCounts: { user: 2, assistant: 2 } },
      { file: '~/b.jsonl', bytes: 20, lines: 8, units: 3, jsonErrors: 0, typeCounts: { user: 3, summary: 1 } },
      { file: '~/c.jsonl', bytes: 0, lines: 0, units: 0, jsonErrors: 0, typeCounts: {}, readError: 'ENOENT' },
    ]
    expect(totalsOf(files)).toEqual({
      files: 3,
      filesWithReadErrors: 1,
      units: 5,
      jsonErrors: 1,
      typeCounts: { user: 5, assistant: 2, summary: 1 },
    })
  })

  it('handles an empty file list', () => {
    expect(totalsOf([])).toEqual({ files: 0, filesWithReadErrors: 0, units: 0, jsonErrors: 0, typeCounts: {} })
  })
})

describe('envSnapshot', () => {
  it('records the claude version from a resolving probe', async () => {
    const env = await envSnapshot('0.11.5', async () => ({ version: '2.1.0 (Claude Code)' }))
    expect(env.claude).toEqual({ found: true, version: '2.1.0 (Claude Code)' })
    expect(env.cwcVersion).toBe('0.11.5')
    expect(env.platform).toBe(process.platform)
    expect(env.nodeVersion).toBe(process.version)
  })

  it('records a not-found claude without throwing when the probe rejects', async () => {
    const env = await envSnapshot('0.11.5', async () => { throw new Error('spawn claude ENOENT') })
    expect(env.claude.found).toBe(false)
    expect(env.claude.error).toContain('ENOENT')
  })
})
