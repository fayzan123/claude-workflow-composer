import type { CwcFile, CwcTrigger } from '../types.ts'
import type { AgentEntry } from '../../../src/server/api/agents.ts'
import type { AgentSpec } from '../../../src/generation/agent-generator.ts'
import type { SkillSpec } from '../../../src/generation/skill-generator.ts'
import type { SkillEntry } from '../../../src/server/api/skills.ts'
import type { ExportTarget, ExportResult, ExportPreviewResult } from '../../../src/export/exporter.ts'
import type { AuthorizedDeleteExportResult } from '../../../src/server/api/export-delete.ts'
import type { ExportedWorkflowEntry } from '../../../src/server/api/exported-workflows.ts'
import type { RunEvent } from '../../../src/run-events.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'
import type { DetectedAutomation } from '../../../src/detection/types.ts'
import type { ArtifactTier } from './artifact.ts'

export interface WorkflowListEntry {
  id: string
  path: string
  name: string
  nodeCount: number
  updated: string
  artifactKind?: 'workflow' | 'skill'
  artifactTier?: 'workflow' | 'skill' | 'loop'
}

export interface ScanGeneration {
  id: string
  step: string
  startedAt: string
  tier?: ArtifactTier
  artifactId?: string
  /** Compatibility field for scans persisted before artifact-aware generation. */
  workflowId?: string
  error?: string
}

export interface AutomationScanSnapshot {
  status: string
  startedAt?: string
  finishedAt?: string
  error?: string
  log?: Array<{ ts: string; level: string; message: string }>
  generation?: ScanGeneration | null
  automations: DetectedAutomation[]
}

export type RuleTarget =
  | { type: 'user-claude' }
  | { type: 'project-agents'; projectDir: string }

export interface RecipeAuthority {
  workflowPath: string
  expectedRevision: string
}

export interface AuthorizedExportResult extends ExportResult {
  recipeRevision: string
}

const BASE = '/api'

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function reqWithError<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error || `${method} ${path} failed: ${res.status}`)
  return json as T
}

async function readWorkflow(filePath: string): Promise<{ content: CwcFile; revision: string }> {
  const res = await fetch(`${BASE}/workflows?path=${encodeURIComponent(filePath)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error || `GET /workflows failed: ${res.status}`)
  const revision = res.headers.get('x-cwc-revision')
  if (!revision || !/^[0-9a-f]{64}$/.test(revision)) {
    throw new Error('Workflow response did not include a valid revision.')
  }
  return { content: json as CwcFile, revision }
}

export const api = {
  health: () => req<{ status: string }>('GET', '/health'),
  claudeCheck: () => req<{ installed: boolean; claudeDir: string }>('GET', '/claude-check'),

  workflows: {
    list: () => req<WorkflowListEntry[]>('GET', '/workflows/list'),
    read: readWorkflow,
    create: (content: CwcFile) => req<{ saved: boolean; path: string; revision: string }>('POST', '/workflows/create', { content }),
    save: (filePath: string, content: CwcFile, expectedRevision: string) =>
      reqWithError<{ saved: boolean; revision: string }>('POST', '/workflows', { path: filePath, content, expectedRevision }),
    delete: (filePath: string, cleanupUserExport = false, workflowId?: string) => reqWithError<{ deleted: boolean }>(
      'DELETE',
      `/workflows?path=${encodeURIComponent(filePath)}${cleanupUserExport ? '&cleanupUserExport=1' : ''}${workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : ''}`,
    ),
    rename: (oldPath: string, newName: string, workflowId: string | undefined, expectedRevision: string) =>
      reqWithError<{ path: string; renamed: boolean; revision: string; content: CwcFile }>(
        'POST',
        '/workflows/rename',
        { oldPath, newName, workflowId, expectedRevision },
      ),
  },

  agents: (projectDir?: string) =>
    req<AgentEntry[]>('GET', `/agents${projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : ''}`),

  agentGen: {
    spec: (message: string, sessionId?: string) =>
      reqWithError<{ spec: AgentSpec; sessionId: string }>('POST', '/agents/generate/spec', { message, sessionId }),
    build: (spec: AgentSpec, sessionId?: string) =>
      reqWithError<{ content: string; slug: string }>('POST', '/agents/generate/build', { spec, sessionId }),
  },
  saveAgent: (slug: string, content: string, overwrite = false) =>
    reqWithError<{ slug: string; filePath: string }>('POST', '/agents', { slug, content, overwrite }),

  recents: {
    list: () => req<string[]>('GET', '/recents'),
    add: (filePath: string) => req<string[]>('POST', '/recents', { path: filePath }),
    remove: (filePath: string) => req<string[]>('DELETE', `/recents?path=${encodeURIComponent(filePath)}`),
  },

  skills: () => req<SkillEntry[]>('GET', '/skills'),

  skillGen: {
    spec: (message: string, sessionId?: string) =>
      reqWithError<{ spec: SkillSpec; sessionId: string }>('POST', '/skills/generate/spec', { message, sessionId }),
    build: (spec: SkillSpec, sessionId?: string) =>
      reqWithError<{ content: string; slug: string }>('POST', '/skills/generate/build', { spec, sessionId }),
  },
  saveSkill: (slug: string, content: string, overwrite = false) =>
    reqWithError<{ slug: string; filePath: string }>('POST', '/skills', { slug, content, overwrite }),

  export: (cwcFile: CwcFile, target: ExportTarget, authority: RecipeAuthority) =>
    reqWithError<AuthorizedExportResult>('POST', '/export', { cwcFile, target, ...authority }),

  exportPreview: (cwcFile: CwcFile, target: ExportTarget) =>
    reqWithError<ExportPreviewResult>('POST', '/export/preview', { cwcFile, target }),

  deleteExport: (cwcFile: CwcFile, target: ExportTarget, authority: RecipeAuthority) =>
    reqWithError<AuthorizedDeleteExportResult>('POST', '/export/delete', { cwcFile, target, ...authority }),

  exportedWorkflows: {
    list: () => req<ExportedWorkflowEntry[]>('GET', '/exported-workflows'),
    delete: (slug: string, ownerId: string) => reqWithError<{ deleted: string }>(
      'DELETE',
      `/exported-workflows?slug=${encodeURIComponent(slug)}&ownerId=${encodeURIComponent(ownerId)}`,
    ),
  },

  fileContent: (filePath: string) =>
    req<{ content: string }>('GET', `/file-content?path=${encodeURIComponent(filePath)}`),

  saveFileContent: (filePath: string, content: string) =>
    reqWithError<{ saved: boolean }>('POST', '/file-content', { path: filePath, content }),

  deleteAgent: (filePath: string) =>
    reqWithError<{ deleted: boolean }>('DELETE', `/agents?path=${encodeURIComponent(filePath)}`),

  deleteSkill: (filePath: string) =>
    reqWithError<{ deleted: boolean }>('DELETE', `/skills?path=${encodeURIComponent(filePath)}`),

  openFile: (filePath: string) =>
    req<{ opened: boolean }>('POST', '/open-file', { path: filePath }),

  runs: {
    list: (workflowId: string) =>
      req<RunSummary[]>('GET', `/runs?workflowId=${encodeURIComponent(workflowId)}`),
    events: (workflowId: string, runId: string) =>
      req<RunEvent[]>('GET', `/runs/${encodeURIComponent(runId)}/events?workflowId=${encodeURIComponent(workflowId)}`),
    paused: () =>
      req<RunSummary[]>('GET', '/runs/paused'),
    recent: (limit?: number) =>
      req<RunSummary[]>('GET', `/runs/recent${limit ? `?limit=${limit}` : ''}`),
    diff: (workflowId: string, runId: string) =>
      req<{ diff: string | null; status: string | null; branch: string | null; error?: string }>('GET', `/runs/${encodeURIComponent(runId)}/diff?workflowId=${encodeURIComponent(workflowId)}`),
    approve: (workflowId: string, runId: string, note?: string) =>
      reqWithError<{ resumed: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/approve`, { workflowId, note }),
    reject: (workflowId: string, runId: string, note?: string) =>
      reqWithError<{ rejected: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/reject`, { workflowId, note }),
    apply: (workflowId: string, runId: string) =>
      reqWithError<{ applied: true; disposition: 'applied'; appliedSha: string }>('POST', `/runs/${encodeURIComponent(runId)}/apply`, { workflowId }),
    discard: (workflowId: string, runId: string) =>
      reqWithError<{ discarded: true; disposition: 'discarded'; resultSha: string }>('POST', `/runs/${encodeURIComponent(runId)}/discard`, { workflowId, confirmed: true }),
    start: (workflowId: string, workflowSlug: string, cwd: string, isolation?: 'worktree' | 'in-place') =>
      reqWithError<{ runId: string }>('POST', '/runs/test', { workflowId, workflowSlug, cwd, isolation }),
    stop: (runId: string) =>
      reqWithError<{ stopped: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/stop`),
  },

  serviceStatus: () => req<{ persistent: boolean; platform: string }>('GET', '/service-status'),

  automationScan: {
    latest: () => req<AutomationScanSnapshot>('GET', '/automation-scan'),
    start: (model?: string) => fetch('/api/automation-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    }),
    dismiss: (id: string) => fetch(`/api/automation-scan/${id}/dismiss`, { method: 'POST' }),
    restore: (id: string) => fetch(`/api/automation-scan/${id}/restore`, { method: 'POST' }),
    promote: async (id: string, tier: ArtifactTier) => {
      const res = await fetch(`/api/automation-scan/${id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      })
      const json = await res.json().catch(() => ({})) as { status?: string; tier?: ArtifactTier; error?: string; cancelled?: boolean }
      return { ok: res.ok, httpStatus: res.status, ...json }
    },
    applyRule: (id: string, target: RuleTarget) =>
      reqWithError<{ ok: true; change: string; automation: DetectedAutomation; filePath: string }>('POST', `/automation-scan/${encodeURIComponent(id)}/rule`, { target }),
    removeRule: (id: string, target: RuleTarget) =>
      reqWithError<{ ok: true; change: string; automation: DetectedAutomation; filePath: string }>('POST', `/automation-scan/${encodeURIComponent(id)}/rule/remove`, { target }),
    cancelPromote: (id: string) => fetch(`/api/automation-scan/${id}/promote/cancel`, { method: 'POST' }),
  },

  automations: {
    state: () => req<{ paused: boolean }>('GET', '/automations/state'),
    setPaused: (paused: boolean) => req<{ paused: boolean }>('PUT', '/automations/state', { paused }),
    arm: (trigger: CwcTrigger) => reqWithError<{ armed: boolean }>('POST', '/automations/arm', { trigger }),
    triggerStatus: (trigger: CwcTrigger) =>
      req<{ armed: boolean; lastFiredAt?: string; skippedCount: number; lastSkip?: { ts: string; reason: string } }>('POST', '/automations/trigger-status', { trigger }),
    triggers: () =>
      req<{ workflowId: string; workflowName: string; artifactTier?: 'workflow' | 'skill' | 'loop'; triggerId: string; schedule: string; enabled: boolean; armed: boolean; nextFireAt: string | null; lastFiredAt: string | null; lastSkip: { ts: string; reason: string } | null }[]>('GET', '/automations/triggers'),
    config: () => req<{ notifications: { macos: boolean; webhookUrl?: string } }>('GET', '/automations/config'),
    setConfig: (c: { notifications: { macos: boolean; webhookUrl?: string } }) => req<typeof c>('PUT', '/automations/config', c),
  },
}
