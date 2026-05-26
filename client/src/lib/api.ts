import type { CwcFile } from '../types.ts'
import type { AgentEntry } from '../../../src/server/api/agents.ts'
import type { SkillEntry } from '../../../src/server/api/skills.ts'
import type { ExportTarget, ExportResult } from '../../../src/exporter.ts'

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

export const api = {
  health: () => req<{ status: string }>('GET', '/health'),
  claudeCheck: () => req<{ installed: boolean; claudeDir: string }>('GET', '/claude-check'),

  workflows: {
    list: () => req<{ path: string; name: string; updated: string }[]>('GET', '/workflows/list'),
    read: (filePath: string) => req<CwcFile>('GET', `/workflows?path=${encodeURIComponent(filePath)}`),
    save: (filePath: string, content: CwcFile) => req<{ saved: boolean }>('POST', '/workflows', { path: filePath, content }),
    delete: (filePath: string) => req<{ deleted: boolean }>('DELETE', `/workflows?path=${encodeURIComponent(filePath)}`),
  },

  agents: (projectDir?: string) =>
    req<AgentEntry[]>('GET', `/agents${projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : ''}`),

  recents: {
    list: () => req<string[]>('GET', '/recents'),
    add: (filePath: string) => req<string[]>('POST', '/recents', { path: filePath }),
  },

  skills: () => req<SkillEntry[]>('GET', '/skills'),

  export: (cwcFile: CwcFile, target: ExportTarget) =>
    req<ExportResult>('POST', '/export', { cwcFile, target }),

  exportPreview: (cwcFile: CwcFile, target: ExportTarget) =>
    req<{ files: { path: string; content: string }[]; warnings: string[] }>('POST', '/export/preview', { cwcFile, target }),
}
