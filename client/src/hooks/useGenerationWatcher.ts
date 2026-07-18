import { useEffect, useRef } from 'react'
import { api } from '../lib/api.ts'
import { scanCompletionNotification, type ScanWatcherSnapshot } from '../lib/scan-watcher.ts'
import { toast } from '../lib/toast.ts'
import { artifactTierLabel, type ArtifactTier } from '../lib/artifact.ts'

/** Event fired on the window when a background generation finishes, so any
 *  mounted view (e.g. the dashboard's workflow list) can refresh itself. */
export const WORKFLOW_GENERATED_EVENT = 'cwc:workflow-generated'

function generationNotificationKey(gen: { id: string; startedAt: string; artifactId?: string; workflowId?: string; tier?: ArtifactTier; error?: string }): string {
  return `${gen.id}:${gen.startedAt}:${gen.artifactId ?? gen.workflowId ?? gen.error ?? ''}:${gen.tier ?? ''}`
}

/**
 * Shell-level watcher: polls generation state on every route so a workflow that
 * finishes (or fails) in the background always surfaces a toast — even when neither
 * the Detect view nor its hero is mounted. This is the single source of completion
 * notification; route-local views must not fire their own completion toast or it
 * would double up.
 */
export function useGenerationWatcher(navigate?: (path: string) => void): void {
  const seen = useRef<Set<string>>(new Set())
  const generationInitialized = useRef(false)
  const previousScan = useRef<ScanWatcherSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    let inFlight = false

    async function poll() {
      if (inFlight) return
      inFlight = true
      let r: Awaited<ReturnType<typeof api.automationScan.latest>>
      try { r = await api.automationScan.latest() } catch { return } finally { inFlight = false }
      if (!alive) return

      const currentScan: ScanWatcherSnapshot = {
        status: r.status,
        startedAt: r.startedAt,
        error: r.error,
        automations: r.automations,
      }
      const scanNotice = scanCompletionNotification(previousScan.current, currentScan)
      previousScan.current = currentScan
      if (scanNotice) {
        const action = navigate ? { label: 'Review', onClick: () => navigate('/detect') } : undefined
        if (scanNotice.tone === 'success') toast.success(scanNotice.title, scanNotice.detail, action)
        else toast.error(scanNotice.title, scanNotice.detail, action)
      }

      const gen = r.generation
      if (!gen) {
        generationInitialized.current = true
        return
      }
      const artifactId = gen.artifactId ?? gen.workflowId
      const terminal = Boolean(artifactId) || Boolean(gen.error)
      if (!terminal) {
        generationInitialized.current = true
        return
      }

      // First successful poll: seed already-finished generations so a result that
      // completed before this tab opened doesn't fire a stale toast on load.
      const key = generationNotificationKey(gen)
      if (!generationInitialized.current) {
        seen.current.add(key)
        generationInitialized.current = true
        return
      }
      if (seen.current.has(key)) return
      seen.current.add(key)

      const title = r.automations.find(a => a.id === gen.id)?.title
      if (artifactId) {
        const tier = gen.tier ?? r.automations.find(a => a.id === gen.id)?.selectedTier ?? 'workflow'
        const label = artifactTierLabel(tier)
        toast.success(
          `${label} generated`,
          title ? `"${title}" is ready in Saved artifacts` : 'Ready in Saved artifacts',
          navigate ? { label: 'Open', onClick: () => navigate(`/w/${artifactId}/build`) } : undefined,
        )
        window.dispatchEvent(new CustomEvent(WORKFLOW_GENERATED_EVENT, { detail: { artifactId, tier } }))
      } else if (gen.error) {
        const label = artifactTierLabel(gen.tier ?? 'workflow')
        toast.error(
          `${label} generation failed`,
          title ? `"${title}" — ${gen.error}` : gen.error,
          navigate ? { label: 'Review', onClick: () => navigate('/detect') } : undefined,
        )
      }
    }

    void poll()
    const id = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [navigate])
}
