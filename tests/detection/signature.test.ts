import { describe, it, expect } from 'vitest'
import { deriveSignature } from '../../src/detection/signature.js'
import type { TaskUnit } from '../../src/detection/types.js'

function unit(commands: string[], tools: string[] = ['Edit']): TaskUnit {
  return { sessionId: 'S', cwd: '/r', startedAt: '', endedAt: '', tools, commands }
}

describe('deriveSignature', () => {
  it('keys on salient commands, ignoring noise/order', () => {
    const a = deriveSignature(unit(['npm test', 'git push']))
    const b = deriveSignature(unit(['git push', 'npm test', 'ls -la']))
    expect(a).not.toBeNull()
    expect(a!.signature).toBe(b!.signature)         // same salient set → same key
    expect(a!.labels.sort()).toEqual(['git-push', 'tests'])
  })
  it('returns null when no salient command is present (pure noise)', () => {
    expect(deriveSignature(unit(['ls', 'cat foo'], ['Read']))).toBeNull()
  })
  it('recognizes pr-create, publish, build, deploy', () => {
    expect(deriveSignature(unit(['gh pr create -t x']))!.labels).toContain('pr-create')
    expect(deriveSignature(unit(['npm publish']))!.labels).toContain('publish')
    expect(deriveSignature(unit(['npm run build']))!.labels).toContain('build')
    expect(deriveSignature(unit(['./deploy.sh prod']))!.labels).toContain('deploy')
  })
})
