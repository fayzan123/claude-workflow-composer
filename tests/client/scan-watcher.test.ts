import { describe, expect, it } from 'vitest'
import { scanCompletionNotification } from '../../client/src/lib/scan-watcher.ts'

const running = {
  status: 'running',
  startedAt: '2026-07-14T12:00:00.000Z',
  automations: [],
}

describe('scan completion notifications', () => {
  it('does not announce a terminal scan while initializing', () => {
    expect(scanCompletionNotification(null, {
      status: 'done',
      startedAt: running.startedAt,
      automations: [{ status: 'new' }],
    })).toBeNull()
  })

  it('announces a running scan when it completes', () => {
    expect(scanCompletionNotification(running, {
      status: 'done',
      startedAt: running.startedAt,
      automations: [{ status: 'new' }, { status: 'dismissed' }],
    })).toEqual({
      tone: 'success',
      title: 'History scan complete',
      detail: '1 automation found',
    })
  })

  it('announces a scan that starts and finishes between polls', () => {
    expect(scanCompletionNotification({
      status: 'done',
      startedAt: '2026-07-14T11:00:00.000Z',
      automations: [],
    }, {
      status: 'done',
      startedAt: running.startedAt,
      automations: [],
    })).toMatchObject({ tone: 'success', detail: 'No strong patterns found this time' })
  })

  it('announces a first scan that starts and finishes after an idle poll', () => {
    expect(scanCompletionNotification({
      status: 'idle',
      automations: [],
    }, {
      status: 'done',
      startedAt: running.startedAt,
      automations: [{ status: 'new' }],
    })).toMatchObject({ tone: 'success', detail: '1 automation found' })
  })

  it('announces the persisted failure detail once', () => {
    expect(scanCompletionNotification(running, {
      status: 'error',
      startedAt: running.startedAt,
      error: 'Claude exited before returning a result.',
      automations: [],
    })).toEqual({
      tone: 'error',
      title: 'History scan failed',
      detail: 'Claude exited before returning a result.',
    })
    expect(scanCompletionNotification({ ...running, status: 'error' }, {
      ...running,
      status: 'error',
    })).toBeNull()
  })
})
