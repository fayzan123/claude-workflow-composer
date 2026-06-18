import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/server/index.js'
import type { ClaudeRunner } from '../../src/server/claude-runner.js'
import type { StreamingRunner } from '../../src/server/streaming-analyzer.js'
import { triggersForAutomation } from '../../src/server/api/automation-scan.js'
import type { DetectedAutomation } from '../../src/detection/types.js'

let lastScanModel: string | undefined
let lastWorkflowPrompt: string | undefined
let workflowRunnerDelay: Promise<void> | null = null
const fakeStreaming: StreamingRunner = async (_prompt, { onLog, model }) => {
  lastScanModel = model
  onLog({ level: 'info', message: 'session started' })
  onLog({ level: 'claude', message: 'clustering recurring tasks' })
  return { resultText: JSON.stringify({ automations: [{
    title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
    stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
    suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9,
  }] }), costUsd: 0.01 }
}

let home: string, scanPath: string, wfDir: string, server: http.Server, base: string

const cannedRunner = async () => ({
  result: JSON.stringify({ automations: [{
    title: 'Run tests then push', description: 'd', steps: ['test', 'push'],
    stepTokens: ['run-tests', 'push'], refs: ['r0', 'r1', 'r2'],
    suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' }, confidence: 0.9,
  }] }), sessionId: 's',
})

async function waitWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) { await promise; return }
  if (signal.aborted) throw new Error('claude cancelled.')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(new Error('claude cancelled.')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => { cleanup(); resolve() },
      err => { cleanup(); reject(err) },
    )
  })
}

const smartRunner: ClaudeRunner = async (prompt, opts) => {
  if (prompt.includes('.cwc') || prompt.includes('"nodes"')) {
    if (workflowRunnerDelay) await waitWithAbort(workflowRunnerDelay, opts?.signal)
    lastWorkflowPrompt = prompt
    return { result: JSON.stringify({
      meta: { id: 'wf-1', name: 'Tests And Push', description: 'd', version: 1, created: '2026-06-17T00:00:00Z', updated: '2026-06-17T00:00:00Z' },
      nodes: [
        { id: 'n1', position: { x: 100, y: 300 }, exportedSlug: null, agentRef: 'runner-agent', agent: { name: 'Runner Agent', description: 'd', completionCriteria: 'c', skills: ['real-skill'] } },
        { id: 'n2', position: { x: 450, y: 300 }, exportedSlug: null, agentRef: 'ghost-agent', agent: { name: 'Generated Runner', description: 'd', completionCriteria: 'c', skills: ['real-skill', 'fake-skill'] } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', trigger: 'handoff' },
        { id: 'e2', from: 'n2', to: null, trigger: 'done', terminalType: 'complete' },
      ],
    }), sessionId: 's' }
  }
  return cannedRunner()
}

beforeEach(async () => {
  lastScanModel = undefined
  lastWorkflowPrompt = undefined
  workflowRunnerDelay = null
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-scanapi-'))
  scanPath = path.join(home, 'scan.json')
  wfDir = path.join(home, 'workflows')
  const proj = path.join(home, '.claude', 'projects', 'p1')
  await fs.mkdir(proj, { recursive: true })
  const L = (o: unknown) => JSON.stringify(o) + '\n'
  const push = (ts: string) => L({ type: 'user', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } })
    + L({ type: 'assistant', sessionId: 'S' + ts, cwd: '/r', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test && git push' } }] } })
  await fs.writeFile(path.join(proj, 'S.jsonl'), push('2026-06-01T10:00:00Z') + push('2026-06-02T10:00:00Z') + push('2026-06-03T10:00:00Z'))
  // A real user skill so promote's slug validation has a valid set to filter against.
  const skillDir = path.join(home, '.claude', 'skills', 'real-skill')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Real\ndescription: run the test suite then push to remote\n---\nRuns tests, pushes to remote, verifies the result, and finishes the branch.\n')
  const agentDir = path.join(home, '.claude', 'agents')
  await fs.mkdir(agentDir, { recursive: true })
  await fs.writeFile(path.join(agentDir, 'runner-agent.md'), '---\nname: Runner Agent\ndescription: run tests and push changes\n---\nExisting agent body for running tests and pushing changes safely.\n')
  const app = createApp({ staticDir: null, userHomeDir: home, automationScanPath: scanPath, workflowsDir: wfDir, claudeRunner: smartRunner, streamingRunner: fakeStreaming, enableNotifier: false })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.close(); await fs.rm(home, { recursive: true, force: true }) })

async function waitForDone(): Promise<{ automations: { id: string; title: string; status: string }[] }> {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`${base}/api/automation-scan`)).json() as { status?: string }
    if (r.status === 'done' || r.status === 'error') return r as never
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error('scan did not finish')
}

async function waitForAutomationStatus(id: string, status: string): Promise<{ automations: { id: string; title: string; status: string; statusDetail?: string }[] }> {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`${base}/api/automation-scan`)).json() as { automations?: { id: string; status: string }[] }
    if (r.automations?.some(a => a.id === id && a.status === status)) return r as never
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error(`automation ${id} did not reach ${status}`)
}

describe('automation-scan API', () => {
  it('runs a scan and returns detected automations, then dismiss persists', async () => {
    const start = await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    expect(start.status).toBe(202)
    const done = await waitForDone()
    expect(done.automations).toHaveLength(1)
    expect(done.automations[0].title).toBe('Run tests then push')
    // NEW: the streamed log is buffered and returned
    const withLog = await (await fetch(`${base}/api/automation-scan`)).json() as { log: { level: string; message: string }[] }
    expect(withLog.log.some(l => l.message === 'clustering recurring tasks')).toBe(true)
    expect(withLog.log.some(l => l.level === 'info' && /digest lines|task units|transcript/i.test(l.message))).toBe(true)

    const id = done.automations[0].id
    const dis = await fetch(`${base}/api/automation-scan/${id}/dismiss`, { method: 'POST' })
    expect(dis.status).toBe(200)
    const after = await (await fetch(`${base}/api/automation-scan`)).json() as { automations: { status: string }[] }
    expect(after.automations[0].status).toBe('dismissed')
  })

  it('runs the analysis on the requested allowlisted model', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'haiku' }) })
    await waitForDone()
    expect(lastScanModel).toBe('claude-haiku-4-5')
  })

  it('falls back to sonnet for an unknown/absent model', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-9' }) })
    await waitForDone()
    expect(lastScanModel).toBe('claude-sonnet-4-6')
  })

  it('promote generates a .cwc with a disabled cron trigger and marks the candidate promoted', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    const done = await waitForDone()
    const id = done.automations[0].id

    const res = await fetch(`${base}/api/automation-scan/${id}/promote`, { method: 'POST' })
    expect(res.status).toBe(200)
    const { workflowId } = await res.json() as { workflowId: string }
    // Server assigns a fresh UUID — it must be a non-empty string, must NOT be the
    // LLM-generated 'wf-1', and must look like a UUID (contains hyphens).
    expect(typeof workflowId).toBe('string')
    expect(workflowId.length).toBeGreaterThan(0)
    expect(workflowId).not.toBe('wf-1')
    expect(workflowId).toMatch(/^[0-9a-f-]{36}$/)

    const files = await fs.readdir(wfDir)
    expect(files.some(f => f.endsWith('.cwc'))).toBe(true)
    const cwc = JSON.parse(await fs.readFile(path.join(wfDir, files[0]), 'utf-8'))
    // The written file must carry the server-assigned id (same as the returned workflowId)
    expect(cwc.meta.id).toBe(workflowId)
    expect(Date.parse(cwc.meta.created)).toBeGreaterThan(Date.parse('2026-06-17T00:00:00Z'))
    expect(cwc.meta.updated).toBe(cwc.meta.created)
    expect(cwc.meta.triggers[0].type).toBe('cron')
    expect(cwc.meta.triggers[0].enabled).toBe(false)
    expect(cwc.meta.triggers[0].cwd).toBe('')
    expect(lastWorkflowPrompt).toContain('Runs tests, pushes to remote')
    expect(lastWorkflowPrompt).toContain('Existing agent body for running tests')
    // Reuse validation: valid agentRef is kept and stays a pure reference;
    // hallucinated agentRef is dropped, while valid skill reuse is capped to one.
    expect(cwc.nodes[0].agentRef).toBe('runner-agent')
    expect(cwc.nodes[0].agent.skills).toEqual([])
    expect(cwc.nodes[0].agent.tools).toEqual([])
    expect(cwc.nodes[0].agent.systemPrompt).toBe('')
    expect(cwc.nodes[0].agent.completionCriteria).toBe('')
    expect(cwc.nodes[1].agentRef).toBeUndefined()
    expect(cwc.nodes[1].agent.skills).toEqual(['real-skill'])

    const after = await (await fetch(`${base}/api/automation-scan`)).json() as { automations: { status: string }[] }
    expect(after.automations[0].status).toBe('promoted')
  })

  it('persists promoting status during workflow generation and blocks conflicting actions', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    const done = await waitForDone()
    const id = done.automations[0].id
    let releaseDelay = () => {}
    workflowRunnerDelay = new Promise<void>(resolve => { releaseDelay = () => resolve() })

    const promotePromise = fetch(`${base}/api/automation-scan/${id}/promote`, { method: 'POST' })
    try {
      const during = await waitForAutomationStatus(id, 'promoting')
      expect(during.automations[0].status).toBe('promoting')

      const startAgain = await fetch(`${base}/api/automation-scan`, { method: 'POST' })
      expect(startAgain.status).toBe(409)
      const dismiss = await fetch(`${base}/api/automation-scan/${id}/dismiss`, { method: 'POST' })
      expect(dismiss.status).toBe(409)
      const promoteAgain = await fetch(`${base}/api/automation-scan/${id}/promote`, { method: 'POST' })
      expect(promoteAgain.status).toBe(409)

      releaseDelay()
      workflowRunnerDelay = null
      const res = await promotePromise
      expect(res.status).toBe(200)
      await waitForAutomationStatus(id, 'promoted')
    } finally {
      releaseDelay()
      workflowRunnerDelay = null
      await promotePromise.catch(() => undefined)
    }
  })

  it('cancels active workflow generation and leaves the candidate retryable', async () => {
    await fetch(`${base}/api/automation-scan`, { method: 'POST' })
    const done = await waitForDone()
    const id = done.automations[0].id
    workflowRunnerDelay = new Promise<void>(() => {})

    const promotePromise = fetch(`${base}/api/automation-scan/${id}/promote`, { method: 'POST' })
    try {
      await waitForAutomationStatus(id, 'promoting')

      const cancel = await fetch(`${base}/api/automation-scan/${id}/promote/cancel`, { method: 'POST' })
      expect(cancel.status).toBe(200)
      expect(await cancel.json()).toEqual({ cancelled: true })

      const promoted = await promotePromise
      expect(promoted.status).toBe(499)
      expect(await promoted.json()).toMatchObject({ cancelled: true })

      const after = await waitForAutomationStatus(id, 'promotion_cancelled')
      expect(after.automations[0].statusDetail).toContain('cancelled')
      await expect(fs.readdir(wfDir)).rejects.toThrow()
    } finally {
      workflowRunnerDelay = null
      await promotePromise.catch(() => undefined)
    }
  })
})

describe('triggersForAutomation', () => {
  const base = (kind: 'schedule' | 'manual' | 'event'): DetectedAutomation => ({
    id: 'i', title: 't', description: 'd', steps: [], stepTokens: [],
    evidence: { count: 3, repos: ['/r'], sessionIds: [], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind, cron: kind === 'schedule' ? '0 9 * * 1' : undefined, label: '' },
    confidence: 0.9, status: 'new',
  })

  it('seeds a disabled cron trigger only for schedule-shaped automations', () => {
    const sched = triggersForAutomation(base('schedule'))
    expect(sched).toHaveLength(1)
    expect(sched[0].type).toBe('cron')
    expect(sched[0].enabled).toBe(false)
    expect(sched[0].schedule).toBe('0 9 * * 1')
    expect(sched[0].cwd).toBe('')
  })

  it('seeds NO trigger for manual or event automations', () => {
    expect(triggersForAutomation(base('manual'))).toEqual([])
    expect(triggersForAutomation(base('event'))).toEqual([])
  })
})
