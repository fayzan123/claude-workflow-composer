import { describe, it, expect } from 'vitest'
import { resolveAuthToken } from '../../src/server/security.js'

describe('resolveAuthToken', () => {
  it('returns a token by default (auth on)', () => {
    expect(resolveAuthToken({})).toBeTypeOf('string')
  })

  it('returns undefined when CWC_DISABLE_AUTH=1 (dev escape hatch)', () => {
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '1' })).toBeUndefined()
  })

  it('only disables on the exact value "1", not any truthy string', () => {
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: 'true' })).toBeTypeOf('string')
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '0' })).toBeTypeOf('string')
    expect(resolveAuthToken({ CWC_DISABLE_AUTH: '' })).toBeTypeOf('string')
  })

  it('returns a fresh token each call', () => {
    expect(resolveAuthToken({})).not.toBe(resolveAuthToken({}))
  })
})
