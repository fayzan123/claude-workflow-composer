import { useEffect, useRef } from 'react'
import { api } from '../lib/api.ts'
import { toast } from '../lib/toast.ts'

/** Event fired on the window when a background generation finishes, so any
 *  mounted view (e.g. the dashboard's workflow list) can refresh itself. */
export const WORKFLOW_GENERATED_EVENT = 'cwc:workflow-generated'

/**
 * Shell-level watcher: polls generation state on every route so a workflow that
 * finishes (or fails) in the background always surfaces a toast — even when neither
 * the Detect view nor its hero is mounted. This is the single source of completion
 * notification; route-local views must not fire their own completion toast or it
 * would double up.
 */
export function useGenerationWatcher(): void {
  const seen = useRef<Set<string>>(new Set())
  const initialized = useRef(false)

  useEffect(() => {
    let alive = true

    async function poll() {
      let r: Awaited<ReturnType<typeof api.automationScan.latest>>
      try { r = await api.automationScan.latest() } catch { return }
      if (!alive) return

      const gen = r.generation
      if (!gen) return
      const terminal = Boolean(gen.workflowId) || Boolean(gen.error)
      if (!terminal) return

      // First successful poll: seed already-finished generations so a result that
      // completed before this tab opened doesn't fire a stale toast on load.
      if (!initialized.current) { seen.current.add(gen.id); return }
      if (seen.current.has(gen.id)) return
      seen.current.add(gen.id)

      const title = r.automations.find(a => a.id === gen.id)?.title
      if (gen.workflowId) {
        toast.success('Workflow generated', title ? `"${title}" is ready in Workflows` : 'Ready in Workflows')
        window.dispatchEvent(new CustomEvent(WORKFLOW_GENERATED_EVENT, { detail: { workflowId: gen.workflowId } }))
      } else if (gen.error) {
        toast.error('Workflow generation failed', title ? `"${title}" — ${gen.error}` : gen.error)
      }
    }

    poll().finally(() => { initialized.current = true })
    const id = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [])
}
