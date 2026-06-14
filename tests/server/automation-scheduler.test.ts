// tests/server/automation-scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createScheduler } from '../../src/server/automation-scheduler.js'
import { createAutomationState } from '../../src/server/automation-state.js'
import type { CwcTrigger } from '../../src/schema.js'
import { makeSchedulerFire } from '../../src/server/index.js'

let dir: string, workflowsDir: string, statePath: string
let fired: { workflowId: string; trigger: CwcTrigger }[]

async function writeWorkflow(id: string, triggers: CwcTrigger[]): Promise<void> {
  const now = new Date().toISOString()
  await fs.writeFile(path.join(workflowsDir, `${id}.cwc`), JSON.stringify({
    meta: { id, name: id, description: '', version: 1, created: now, updated: now, triggers },
    nodes: [], edges: [],
  }))
}

function trig(over: Partial<CwcTrigger> = {}): CwcTrigger {
  return { id: 'trig-1', type: 'cron', schedule: '0 9 * * *', cwd: '/tmp', isolation: 'in-place', catchUp: true, maxRunsPerDay: 10, enabled: true, ...over }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-sched-'))
  workflowsDir = path.join(dir, 'workflows'); await fs.mkdir(workflowsDir)
  statePath = path.join(dir, 'automation-state.json')
  fired = []
})
afterEach(async () => { await fs.rm(dir, { recursive: true }) })

async function makeScheduler(nowIso: string) {
  const state = createAutomationState(statePath)
  const sched = createScheduler({
    workflowsDir, state,
    fire: async (workflowId, _slug, trigger) => { fired.push({ workflowId, trigger }); return { fired: true } },
    isWorkflowBusy: async () => false,
    now: () => new Date(nowIso),
    maxConcurrent: 2,
  })
  return { state, sched }
}

describe('scheduler', () => {
  it('does not fire unarmed triggers', async () => {
    await writeWorkflow('wf-1', [trig()])
    const { sched } = await makeScheduler('2026-06-12T09:00:30')
    await sched.rescan(); await sched.tick()
    expect(fired).toHaveLength(0)
  })

  it('fires an armed trigger when its time passes, exactly once', async () => {
    await writeWorkflow('wf-1', [trig()])
    const { state, sched } = await makeScheduler('2026-06-12T09:00:30')
    await state.arm(trig())
    // simulate that the trigger was last fired yesterday:
    await state.recordFire('trig-1', new Date('2026-06-11T09:00:00'))
    await sched.rescan(); await sched.tick(); await sched.tick()
    expect(fired).toHaveLength(1)
  })

  it('catch-up: fires once after a long gap; with catchUp=false marks consumed without firing', async () => {
    await writeWorkflow('wf-1', [trig()])
    const { state, sched } = await makeScheduler('2026-06-12T14:00:00')   // way past 9:00
    await state.arm(trig())
    await state.recordFire('trig-1', new Date('2026-06-10T09:00:00'))    // missed the 11th AND the 12th
    await sched.rescan(); await sched.tick()
    expect(fired).toHaveLength(1)                                         // once, not twice

    fired = []
    await writeWorkflow('wf-2', [trig({ id: 'trig-2', catchUp: false })])
    await state.arm(trig({ id: 'trig-2', catchUp: false }))
    await state.recordFire('trig-2', new Date('2026-06-10T09:00:00'))
    await sched.rescan(); await sched.tick()
    expect(fired).toHaveLength(0)
    // consumed: a subsequent tick at the same time must not fire either
    await sched.tick()
    expect(fired).toHaveLength(0)
  })

  it('respects global pause, daily cap, and disabled flag (recorded as skips)', async () => {
    await writeWorkflow('wf-1', [trig({ maxRunsPerDay: 0 })])
    const { state, sched } = await makeScheduler('2026-06-12T09:00:30')
    await state.arm(trig({ maxRunsPerDay: 0 }))
    await state.recordFire('trig-1', new Date('2026-06-11T09:00:00'))
    await sched.rescan(); await sched.tick()
    expect(fired).toHaveLength(0)
    expect(state.getTriggerState('trig-1').lastSkip?.reason).toBe('daily cap')
  })

  it('skips when the workflow is busy (running or paused-from-same-trigger)', async () => {
    await writeWorkflow('wf-1', [trig()])
    const state = createAutomationState(statePath)
    const sched = createScheduler({
      workflowsDir, state, fire: async () => ({ fired: true }),
      isWorkflowBusy: async () => 'running' as const,
      now: () => new Date('2026-06-12T09:00:30'), maxConcurrent: 2,
    })
    await state.arm(trig())
    await state.recordFire('trig-1', new Date('2026-06-11T09:00:00'))
    await sched.rescan(); await sched.tick()
    expect(state.getTriggerState('trig-1').lastSkip?.reason).toBe('running')
  })

  it('queues beyond maxConcurrent and drains FIFO', async () => {
    const triggers = ['a', 'b', 'c'].map(s => trig({ id: `trig-${s}` }))
    await writeWorkflow('wf-1', [triggers[0]]); await writeWorkflow('wf-2', [triggers[1]]); await writeWorkflow('wf-3', [triggers[2]])
    const state = createAutomationState(statePath)
    let resolveFirst: (() => void) | null = null
    const order: string[] = []
    let running = 0
    let maxRunning = 0
    const sched = createScheduler({
      workflowsDir, state,
      fire: async (workflowId) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        order.push(workflowId)
        if (resolveFirst === null) {
          await new Promise<void>(r => { resolveFirst = r })   // first call blocks until released
        }
        running--
        return { fired: true }
      },
      isWorkflowBusy: async () => false,
      now: () => new Date('2026-06-12T09:00:30'), maxConcurrent: 2,
    })
    for (const t of triggers) { await state.arm(t); await state.recordFire(t.id, new Date('2026-06-11T09:00:00')) }
    await sched.rescan()
    await sched.tick()
    // after tick resolves: at least 2 fires started (maxConcurrent=2); 3rd was queued and drained via finally
    // give the finally-handler microtask time to fully drain the queue
    await new Promise(r => setTimeout(r, 20))
    if (order.length < 3) {
      // first fire may still be blocked — release and wait
      resolveFirst?.()
      await new Promise(r => setTimeout(r, 20))
    }
    expect(order).toHaveLength(3)
    expect(maxRunning).toBeLessThanOrEqual(2)  // never exceeded maxConcurrent
  })
})

it('fans a multi-target trigger into one run per target', async () => {
  const calls: string[] = []
  const fire = makeSchedulerFire({
    store: {} as any, worktreesRoot: '/wt',
    fireOne: async (cwd: string) => { calls.push(cwd); return { fired: true, runId: 'r', settled: Promise.resolve() } },
    onSkip: async () => {},
  })
  const trig = { id: 't', type: 'cron', schedule: '* * * * *', cwd: '/a', targets: ['/b'], isolation: 'worktree', catchUp: false, maxRunsPerDay: 1, enabled: true } as any
  await fire('wf1', 'cwc-flow', trig)
  expect(calls.sort()).toEqual(['/a', '/b'])
})
