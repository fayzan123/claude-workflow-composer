import { describe, expect, it } from 'vitest'
import {
  INITIAL_RUN_RESULT_ACTION_STATE,
  runResultActionReducer,
} from '../../client/src/lib/run-result-actions.js'

describe('runResultActionReducer', () => {
  it('uses an explicit two-step Discard confirmation', () => {
    const confirming = runResultActionReducer(INITIAL_RUN_RESULT_ACTION_STATE, { type: 'request_discard' })
    expect(confirming.confirmingDiscard).toBe(true)
    expect(runResultActionReducer(confirming, { type: 'cancel_discard' })).toEqual(INITIAL_RUN_RESULT_ACTION_STATE)
  })

  it('blocks duplicate starts while an action is pending', () => {
    const applying = runResultActionReducer(INITIAL_RUN_RESULT_ACTION_STATE, { type: 'start', action: 'apply' })
    const duplicate = runResultActionReducer(applying, { type: 'start', action: 'discard' })
    expect(duplicate).toBe(applying)
    expect(duplicate.pending).toBe('apply')
  })

  it('tracks optimistic terminal state after success and retryable inline errors after failure', () => {
    const applying = runResultActionReducer(INITIAL_RUN_RESULT_ACTION_STATE, { type: 'start', action: 'apply' })
    expect(runResultActionReducer(applying, { type: 'succeed', action: 'apply' })).toMatchObject({ pending: null, completed: 'apply', error: null })
    expect(runResultActionReducer(applying, { type: 'fail', message: 'Destination moved.' })).toMatchObject({ pending: null, completed: null, error: 'Destination moved.' })
  })

  it('resets state when a different run is selected', () => {
    const failed = runResultActionReducer(INITIAL_RUN_RESULT_ACTION_STATE, { type: 'fail', message: 'Nope' })
    expect(runResultActionReducer(failed, { type: 'reset' })).toEqual(INITIAL_RUN_RESULT_ACTION_STATE)
  })
})
