import { describe, it, expect } from 'vitest'
import { diffLineKind } from '../../client/src/lib/diff-lines.ts'

describe('diffLineKind', () => {
  it('colors added and removed content lines', () => {
    expect(diffLineKind('+dogfood smoke OK')).toBe('add')
    expect(diffLineKind('-old line')).toBe('del')
  })
  it('treats file headers as meta, not add/del', () => {
    expect(diffLineKind('+++ b/notes-dogfood.md')).toBe('meta')
    expect(diffLineKind('--- /dev/null')).toBe('meta')
    expect(diffLineKind('diff --git a/x b/x')).toBe('meta')
    expect(diffLineKind('index 0000000..1f07ef')).toBe('meta')
  })
  it('marks hunk headers and context', () => {
    expect(diffLineKind('@@ -0,0 +1 @@')).toBe('hunk')
    expect(diffLineKind(' unchanged context')).toBe('ctx')
    expect(diffLineKind('')).toBe('ctx')
  })
})
