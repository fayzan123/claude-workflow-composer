// src/server/run-store.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { RunEvent, RunStatus } from '../run-events.js'

export const STALE_AFTER_MS = 15 * 60_000

export interface RunSummary {
  runId: string
  workflowId: string
  workflowSlug: string
  source: 'test' | 'external'
  status: RunStatus | 'running' | 'stale'
  startedAt: string
  lastEventAt: string
  durationMs: number
  cwd?: string
}

export interface RunStore {
  append(event: RunEvent): Promise<void>
  getEvents(workflowId: string, runId: string): Promise<RunEvent[] | null>
  listRuns(workflowId: string): Promise<RunSummary[]>
  onEvent(listener: (e: RunEvent) => void): () => void
  registerChild(runId: string, workflowId: string, child: ChildProcess): void
  getChild(runId: string): ChildProcess | undefined
  releaseChild(runId: string): void
  hasActiveTestRun(workflowId: string): boolean
}

export function createRunStore(runsDir: string): RunStore {
  const listeners = new Set<(e: RunEvent) => void>()
  const children = new Map<string, { workflowId: string; child: ChildProcess }>()

  function runFile(workflowId: string, runId: string): string {
    return path.join(runsDir, workflowId, `${runId}.jsonl`)
  }

  async function readEvents(workflowId: string, runId: string): Promise<RunEvent[] | null> {
    try {
      const raw = await fs.readFile(runFile(workflowId, runId), 'utf-8')
      return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunEvent)
    } catch {
      return null
    }
  }

  function summarize(events: RunEvent[]): RunSummary {
    const first = events[0]
    const last = events[events.length - 1]
    let status: RunSummary['status']
    if (last.type === 'run_completed' && last.status) {
      status = last.status
    } else if (Date.now() - Date.parse(last.ts) > STALE_AFTER_MS) {
      status = 'stale'
    } else {
      status = 'running'
    }
    return {
      runId: first.runId,
      workflowId: first.workflowId,
      workflowSlug: first.workflowSlug,
      source: first.source ?? 'external',
      status,
      startedAt: first.ts,
      lastEventAt: last.ts,
      durationMs: Math.max(0, Date.parse(last.ts) - Date.parse(first.ts)),
      cwd: first.cwd,
    }
  }

  return {
    async append(event: RunEvent): Promise<void> {
      const dir = path.join(runsDir, event.workflowId)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(runFile(event.workflowId, event.runId), JSON.stringify(event) + '\n')
      for (const l of listeners) l(event)
    },

    getEvents: readEvents,

    async listRuns(workflowId: string): Promise<RunSummary[]> {
      let files: string[]
      try {
        files = (await fs.readdir(path.join(runsDir, workflowId))).filter(f => f.endsWith('.jsonl'))
      } catch {
        return []
      }
      const summaries: RunSummary[] = []
      for (const f of files) {
        const events = await readEvents(workflowId, f.replace(/\.jsonl$/, ''))
        if (events && events.length > 0) summaries.push(summarize(events))
      }
      return summaries.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    registerChild(runId, workflowId, child) { children.set(runId, { workflowId, child }) },
    getChild(runId) { return children.get(runId)?.child },
    releaseChild(runId) { children.delete(runId) },
    hasActiveTestRun(workflowId) {
      for (const v of children.values()) if (v.workflowId === workflowId) return true
      return false
    },
  }
}
