import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Server } from 'node:http'
import type { DetectedAutomation } from '../../src/detection/types.js'
import { createApp } from '../../src/server/index.js'
import type { ScanStore } from '../../src/server/scan-store.js'

function automation(repo: string): DetectedAutomation {
  return {
    id: 'abc123',
    title: 'Keep changes scoped',
    description: 'A repeated project instruction.',
    steps: ['Keep changes scoped'],
    stepTokens: ['keep-scoped'],
    evidence: { count: 3, repos: [repo], sessionIds: ['a', 'b', 'c'], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: 'On demand' },
    confidence: 0.9,
    status: 'new',
    recommendedTier: 'rule',
    ruleSuggestion: 'Keep implementation changes scoped to the request.',
  }
}

describe('automation rule API', () => {
  let home: string
  let repo: string
  let server: Server
  let base: string
  let store: ScanStore

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rule-api-home-'))
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rule-api-repo-'))
    const app = createApp({
      staticDir: null,
      userHomeDir: home,
      workflowsDir: path.join(home, 'workflows'),
      automationScanPath: path.join(home, 'scan.json'),
      automationStatePath: path.join(home, 'automation-state.json'),
      configPath: path.join(home, 'config.json'),
      runsDir: path.join(home, 'runs'),
      worktreesRoot: path.join(home, 'worktrees'),
      enableNotifier: false,
    })
    store = app.locals['scanStore'] as ScanStore
    await store.runScan(async () => [automation(repo)])
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(repo, { recursive: true, force: true })
  })

  async function post(pathname: string, target: unknown) {
    return fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    })
  }

  it('explicitly adds an idempotent user rule and records its target', async () => {
    const first = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })
    expect(first.status).toBe(200)
    expect((await first.json() as { change: string }).change).toBe('added')
    const file = path.join(home, '.claude', 'CLAUDE.md')
    expect(await fs.readFile(file, 'utf-8')).toContain('<!-- cwc:rule:abc123 -->')

    const second = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })
    expect((await second.json() as { change: string }).change).toBe('already-present')
    const saved = store.getLatest()!.automations[0]
    expect(saved.selectedTier).toBe('rule')
    expect(saved.ruleApplications).toHaveLength(1)
    expect(saved.status).toBe('promoted')
  })

  it('adds and removes a project rule only in an evidence repository', async () => {
    const added = await post('/api/automation-scan/abc123/rule', { type: 'project-agents', projectDir: repo })
    expect(added.status).toBe(200)
    const agentsFile = path.join(repo, 'AGENTS.md')
    expect(await fs.readFile(agentsFile, 'utf-8')).toContain('Keep implementation changes scoped')

    const removed = await post('/api/automation-scan/abc123/rule/remove', { type: 'project-agents', projectDir: repo })
    expect(removed.status).toBe(200)
    expect((await removed.json() as { change: string }).change).toBe('removed')
    expect(await fs.readFile(agentsFile, 'utf-8')).toBe('')
    expect(store.getLatest()!.automations[0].status).toBe('new')
  })

  it('keeps an applied rule manageable until it is removed', async () => {
    expect((await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })).status).toBe(200)

    const blocked = await fetch(`${base}/api/automation-scan/abc123/dismiss`, { method: 'POST' })
    expect(blocked.status).toBe(409)
    expect((await blocked.json() as { error: string }).error).toContain('Remove every applied rule')
    expect(store.getLatest()!.automations[0].status).toBe('promoted')

    expect((await post('/api/automation-scan/abc123/rule/remove', { type: 'user-claude' })).status).toBe(200)
    expect((await fetch(`${base}/api/automation-scan/abc123/dismiss`, { method: 'POST' })).status).toBe(200)
    expect(store.getLatest()!.automations[0].status).toBe('dismissed')
  })

  it('keeps the successful artifact tier separate when a rule is also applied', async () => {
    await store.updateAutomation('abc123', {
      generatedArtifactId: 'skill-artifact',
      selectedTier: 'skill',
      status: 'promoted',
    })

    const response = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })
    expect(response.status).toBe(200)
    expect(store.getLatest()!.automations[0]).toMatchObject({
      selectedTier: 'rule',
      generatedArtifactId: 'skill-artifact',
      generatedArtifactTier: 'skill',
    })
  })

  it('uses grounded evidence and records an explicit override when adding a rule to a skill-shaped detection', async () => {
    await store.updateAutomation('abc123', {
      title: 'Model-composed title must not become the rule',
      steps: ['Fallback observed step'],
      ruleSuggestion: 'Observed prompt instruction from history.',
      shape: {
        stepArchetypes: ['generic'],
        distinctArchetypes: 0,
        hasToolActivity: true,
        hasVerifySignal: false,
        hasRetryPattern: false,
        hasRiskyStep: false,
        independentStepGroups: 1,
        recurring: false,
      },
      recommendedTier: 'workflow',
    })

    const response = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })
    expect(response.status).toBe(200)
    const raw = await fs.readFile(path.join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(raw).toContain('Observed prompt instruction from history.')
    expect(raw).not.toContain('Model-composed title must not become the rule')
    expect(store.getLatest()!.automations[0]).toMatchObject({
      recommendedTier: 'skill',
      selectedTier: 'rule',
      status: 'promoted',
    })
    expect(store.getLatest()!.automations[0].statusDetail).toContain('recommended Skill')
  })

  it('refuses to invent a rule from model-produced fields when grounded evidence is missing', async () => {
    await store.updateAutomation('abc123', {
      title: 'Model-composed title',
      steps: ['Model-composed step'],
      ruleSuggestion: undefined,
    })

    const response = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })

    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain('evidence-grounded')
    await expect(fs.access(path.join(home, '.claude', 'CLAUDE.md'))).rejects.toThrow()
    expect(store.getLatest()!.automations[0].status).toBe('new')
  })

  it('restores the prior scan state when the guidance file rejects the write', async () => {
    const claudeFile = path.join(home, '.claude', 'CLAUDE.md')
    await fs.mkdir(path.dirname(claudeFile), { recursive: true })
    await fs.writeFile(claudeFile, '<!-- cwc:rule:broken -->\nmissing close\n')

    const response = await post('/api/automation-scan/abc123/rule', { type: 'user-claude' })

    expect(response.status).toBe(409)
    expect(store.getLatest()!.automations[0]).toMatchObject({ status: 'new' })
    expect(store.getLatest()!.automations[0].ruleApplications).toBeUndefined()
    expect(await fs.readFile(claudeFile, 'utf-8')).toBe('<!-- cwc:rule:broken -->\nmissing close\n')
  })

  it('rejects an arbitrary project path outside the automation evidence', async () => {
    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rule-api-foreign-'))
    try {
      const response = await post('/api/automation-scan/abc123/rule', { type: 'project-agents', projectDir: foreign })
      expect(response.status).toBe(400)
      expect(await fs.readdir(foreign)).toEqual([])
    } finally {
      await fs.rm(foreign, { recursive: true, force: true })
    }
  })
})
