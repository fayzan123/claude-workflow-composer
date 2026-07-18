import { describe, expect, it } from 'vitest'
import { createAutomationActivity } from '../../src/server/automation-activity.js'

describe('automation activity lease', () => {
  it('admits one synchronous activity and blocks every competing kind until release', () => {
    const activity = createAutomationActivity()
    const release = activity.tryAcquire('rule')

    expect(release).toBeTypeOf('function')
    expect(activity.activeKind()).toBe('rule')
    expect(activity.tryAcquire('scan')).toBeNull()
    expect(activity.tryAcquire('promotion')).toBeNull()

    release?.()
    expect(activity.activeKind()).toBeNull()
    expect(activity.tryAcquire('scan')).toBeTypeOf('function')
  })

  it('makes release idempotent and prevents a stale release from clearing a newer lease', () => {
    const activity = createAutomationActivity()
    const releaseRule = activity.tryAcquire('rule')!
    releaseRule()
    const releasePromotion = activity.tryAcquire('promotion')!

    releaseRule()
    expect(activity.activeKind()).toBe('promotion')
    releasePromotion()
    expect(activity.activeKind()).toBeNull()
  })
})
