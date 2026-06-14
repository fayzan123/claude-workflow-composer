import { describe, it, expect } from 'vitest'
import { shouldRefreshDashboard } from '../../client/src/lib/dashboard-events.ts'

describe('shouldRefreshDashboard', () => {
  it('refreshes on lifecycle events that change the widgets', () => {
    expect(shouldRefreshDashboard('run_started')).toBe(true)
    expect(shouldRefreshDashboard('run_paused')).toBe(true)
    expect(shouldRefreshDashboard('awaiting_approval')).toBe(true)
    expect(shouldRefreshDashboard('run_completed')).toBe(true)
  })
  it('ignores noisy intra-run events', () => {
    expect(shouldRefreshDashboard('step_started')).toBe(false)
    expect(shouldRefreshDashboard('artifact_produced')).toBe(false)
  })
})
