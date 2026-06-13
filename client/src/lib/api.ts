import type { CwcFile, CwcTrigger } from '../types.ts'
import type { AgentEntry } from '../../../src/server/api/agents.ts'
import type { AgentSpec } from '../../../src/agent-generator.ts'
import type { SkillSpec } from '../../../src/skill-generator.ts'
import type { SkillEntry } from '../../../src/server/api/skills.ts'
import type { ExportTarget, ExportResult } from '../../../src/exporter.ts'
import type { DeleteExportResult } from '../../../src/server/api/export-delete.ts'
import type { ExportedWorkflowEntry } from '../../../src/server/api/exported-workflows.ts'
import type { RunEvent } from '../../../src/run-events.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'

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

export const api = {
  health: () => req<{ status: string }>('GET', '/health'),
  claudeCheck: () => req<{ installed: boolean; claudeDir: string }>('GET', '/claude-check'),

  workflows: {
    list: () => req<{ id: string; path: string; name: string; nodeCount: number; updated: string }[]>('GET', '/workflows/list'),
    read: (filePath: string) => req<CwcFile>('GET', `/workflows?path=${encodeURIComponent(filePath)}`),
    save: (filePath: string, content: CwcFile) => req<{ saved: boolean }>('POST', '/workflows', { path: filePath, content }),
    delete: (filePath: string) => req<{ deleted: boolean }>('DELETE', `/workflows?path=${encodeURIComponent(filePath)}`),
    rename: (oldPath: string, newName: string) =>
      req<{ path: string; renamed: boolean }>('POST', '/workflows/rename', { oldPath, newName }),
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

  export: (cwcFile: CwcFile, target: ExportTarget) =>
    req<ExportResult>('POST', '/export', { cwcFile, target }),

  exportPreview: (cwcFile: CwcFile, target: ExportTarget) =>
    req<{ files: { path: string; content: string }[]; warnings: string[] }>('POST', '/export/preview', { cwcFile, target }),

  deleteExport: (cwcFile: CwcFile, target: ExportTarget) =>
    req<DeleteExportResult>('POST', '/export/delete', { cwcFile, target }),

  exportedWorkflows: {
    list: () => req<ExportedWorkflowEntry[]>('GET', '/exported-workflows'),
    delete: (slug: string) => req<{ deleted: string }>('DELETE', `/exported-workflows?slug=${encodeURIComponent(slug)}`),
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
    diff: (workflowId: string, runId: string) =>
      req<{ diff: string | null; status: string | null; branch: string | null }>('GET', `/runs/${encodeURIComponent(runId)}/diff?workflowId=${encodeURIComponent(workflowId)}`),
    approve: (workflowId: string, runId: string, note?: string) =>
      reqWithError<{ resumed: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/approve`, { workflowId, note }),
    reject: (workflowId: string, runId: string, note?: string) =>
      reqWithError<{ rejected: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/reject`, { workflowId, note }),
    start: (workflowId: string, workflowSlug: string, cwd: string, isolation?: 'worktree' | 'in-place') =>
      reqWithError<{ runId: string }>('POST', '/runs/test', { workflowId, workflowSlug, cwd, isolation }),
    stop: (runId: string) =>
      reqWithError<{ stopped: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/stop`),
  },

  automations: {
    state: () => req<{ paused: boolean }>('GET', '/automations/state'),
    setPaused: (paused: boolean) => req<{ paused: boolean }>('PUT', '/automations/state', { paused }),
    arm: (trigger: CwcTrigger) => reqWithError<{ armed: boolean }>('POST', '/automations/arm', { trigger }),
    triggerStatus: (trigger: CwcTrigger) =>
      req<{ armed: boolean; lastFiredAt?: string; skippedCount: number; lastSkip?: { ts: string; reason: string } }>('POST', '/automations/trigger-status', { trigger }),
    config: () => req<{ notifications: { macos: boolean; webhookUrl?: string } }>('GET', '/automations/config'),
    setConfig: (c: { notifications: { macos: boolean; webhookUrl?: string } }) => req<typeof c>('PUT', '/automations/config', c),
  },
}
