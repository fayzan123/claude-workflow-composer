// tests/run-events.test.ts
import { describe, it, expect } from 'vitest'
import { validateRunEvent } from '../src/run-events.js'

const base = {
  runId: 'run-1718000000-ab12',
  workflowId: 'wf-123',
  workflowSlug: 'cwc-my-pipeline',
  type: 'step_started',
  ts: '2026-06-09T12:00:00.000Z',
}

describe('validateRunEvent', () => {
  it('accepts a minimal valid event', () => {
    const r = validateRunEvent(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('step_started')
  })

  it('rejects non-objects', () => {
    expect(validateRunEvent(null).ok).toBe(false)
    expect(validateRunEvent('hi').ok).toBe(false)
  })

  it('rejects unknown event types', () => {
    const r = validateRunEvent({ ...base, type: 'exploded' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/type/)
  })

  it('rejects missing required fields', () => {
    for (const k of ['runId', 'workflowId', 'workflowSlug', 'ts']) {
      const bad: Record<string, unknown> = { ...base }
      delete bad[k]
      expect(validateRunEvent(bad).ok).toBe(false)
    }
  })

  it('rejects runId/workflowId with path-unsafe characters', () => {
    expect(validateRunEvent({ ...base, runId: '../escape' }).ok).toBe(false)
    expect(validateRunEvent({ ...base, workflowId: 'a/b' }).ok).toBe(false)
  })

  it('rejects run_completed without a valid status', () => {
    expect(validateRunEvent({ ...base, type: 'run_completed' }).ok).toBe(false)
    expect(validateRunEvent({ ...base, type: 'run_completed', status: 'meh' }).ok).toBe(false)
    expect(validateRunEvent({ ...base, type: 'run_completed', status: 'complete' }).ok).toBe(true)
  })

  it('passes through optional fields', () => {
    const r = validateRunEvent({ ...base, nodeId: 'node-1', agentSlug: 'researcher', message: 'go', costUsd: 0.12 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.nodeId).toBe('node-1')
  })
})

describe('automation event types', () => {
  it('accepts awaiting_approval from external ingestion', () => {
    expect(validateRunEvent({ ...base, type: 'awaiting_approval' }).ok).toBe(true)
  })
  it('accepts run_paused with sessionId and passes new optional fields through', () => {
    const r = validateRunEvent({
      ...base, type: 'run_paused', sessionId: 's-1',
      worktreePath: '/tmp/wt', branch: 'cwc/x/run-1', baseSha: 'abc123', trigger: 'trig-1',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.sessionId).toBe('s-1')
      expect(r.event.baseSha).toBe('abc123')
    }
  })
})
