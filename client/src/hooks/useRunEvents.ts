import { useEffect, useRef, useState, useCallback } from 'react'
import type { RunEvent } from '../../../src/run-events.ts'
import type { RunSummary } from '../../../src/server/run-store.ts'
import { api } from '../lib/api.ts'

export interface RunEventsState {
  runs: RunSummary[]
  liveEvents: RunEvent[]          // events of the most recent running run
  activeRun: RunSummary | null    // newest run with status 'running'
  refresh: () => void
}

/** Subscribes to /api/runs/stream and keeps the run list + live event feed for one workflow. */
export function useRunEvents(workflowId: string): RunEventsState {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([])
  const activeRunId = useRef<string | null>(null)

  const refresh = useCallback(() => {
    api.runs.list(workflowId).then(setRuns).catch(() => setRuns([]))
  }, [workflowId])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const es = new EventSource('/api/runs/stream')
    es.onmessage = (msg) => {
      let event: RunEvent
      try { event = JSON.parse(msg.data) } catch { return }
      if (event.workflowId !== workflowId) return
      if (event.type === 'run_started' || activeRunId.current === null) {
        activeRunId.current = event.runId
        setLiveEvents([event])
      } else if (event.runId === activeRunId.current) {
        setLiveEvents(prev => [...prev, event])
      }
      if (event.type === 'run_completed' && event.runId === activeRunId.current) {
        activeRunId.current = null
      }
      refresh()
    }
    return () => es.close()
  }, [workflowId, refresh])

  const activeRun = runs.find(r => r.status === 'running') ?? null
  return { runs, liveEvents, activeRun, refresh }
}
