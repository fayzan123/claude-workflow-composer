// src/server/notifier.ts
import { execFile } from 'node:child_process'
import type { RunStore } from './run-store.js'
import type { RunEvent } from '../run-events.js'
import type { CwcConfig } from './config.js'

export interface NotifierOptions {
  store: RunStore
  getConfig: () => CwcConfig
  /** injectable for tests; default runs osascript */
  execNotify?: (title: string, body: string) => void
}

export function startNotifier(opts: NotifierOptions): () => void {
  const triggerByRun = new Map<string, string>()   // runId → trigger ('manual' | trig-id)
  const suppressNextRunPaused = new Set<string>()

  const macNotify = opts.execNotify ?? ((title: string, body: string) => {
    if (process.platform !== 'darwin') return
    execFile('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => { /* best effort */ })
  })

  function webhookNotify(event: RunEvent): void {
    const url = opts.getConfig().notifications.webhookUrl
    if (!url) return
    void fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event), signal: AbortSignal.timeout(3000),
    }).catch(() => { /* fire and forget */ })
  }

  function notifyPause(e: RunEvent): void {
    if (opts.getConfig().notifications.macos) macNotify('CWC: approval needed', `${e.workflowSlug} is paused at a gate`)
    webhookNotify(e)
  }

  return opts.store.onEvent((e) => {
    if (e.type === 'run_started' && e.trigger) triggerByRun.set(e.runId, e.trigger)
    if (e.type === 'awaiting_approval') {
      notifyPause(e)
      suppressNextRunPaused.add(e.runId)
      return
    }
    if (e.type === 'run_paused') {
      // The CWC harness logs awaiting_approval first, then run_paused with the resumable
      // session id. Notify once for that pause, while still notifying terminal-origin
      // runs that only log awaiting_approval.
      if (!suppressNextRunPaused.delete(e.runId)) notifyPause(e)
      return
    }
    if (e.type === 'run_completed') {
      const trig = triggerByRun.get(e.runId)
      triggerByRun.delete(e.runId)
      suppressNextRunPaused.delete(e.runId)
      if (!trig || trig === 'manual') return   // automation runs only (restart fallback: see note)
      if (opts.getConfig().notifications.macos) macNotify(`CWC: ${e.workflowSlug} ${e.status}`, e.message?.slice(0, 120) ?? '')
      webhookNotify(e)
    }
  })
}
