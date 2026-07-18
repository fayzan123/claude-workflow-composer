import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.ts'
import { mergeScanLogs } from '../lib/scan-log.ts'
import { readScanModel, writeScanModel, type ScanModel } from '../lib/scan-preferences.ts'
import { deriveScanUiState, detectResultsContent } from '../lib/scan-state.ts'
import { toast } from '../lib/toast.ts'
import type { ArtifactTier } from '../lib/artifact.ts'
import type { RuleTarget } from '../lib/api.ts'
import { artifactTierLabel } from '../lib/artifact.ts'
import { ArtifactBadge } from '../components/common/ArtifactBadge.tsx'
import { PromotionDialog } from '../components/detect/PromotionDialog.tsx'
import './DetectView.css'

/** Seconds → m:ss for the live generation timer. */
function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

type Latest = Awaited<ReturnType<typeof api.automationScan.latest>>
type Auto = Latest['automations'][number]
type Log = NonNullable<Latest['log']>[number]
type Generation = NonNullable<Latest['generation']>

function generationArtifactId(generation: Generation | null | undefined): string | undefined {
  return generation?.artifactId ?? generation?.workflowId
}

function recommendedTier(automation: Auto): ArtifactTier {
  return automation.recommendedTier ?? 'workflow'
}

function applicationTargets(automation: Auto): RuleTarget[] {
  const applications = (automation as Auto & { ruleApplications?: unknown[] }).ruleApplications ?? []
  return applications.flatMap((application): RuleTarget[] => {
    const candidate = typeof application === 'object' && application !== null && 'target' in application
      ? (application as { target?: unknown }).target
      : application
    if (typeof candidate !== 'object' || candidate === null || !('type' in candidate)) return []
    const type = (candidate as { type?: unknown }).type
    if (type === 'user-claude') return [{ type }]
    const projectDir = (candidate as { projectDir?: unknown }).projectDir
    if (type === 'project-agents' && typeof projectDir === 'string') {
      return [{ type, projectDir }]
    }
    return []
  })
}

const MODELS = [
  { key: 'haiku',  label: 'Haiku',  pro: 'Fastest and cheapest', con: 'May miss subtler patterns' },
  { key: 'sonnet', label: 'Sonnet', pro: 'Balanced clustering at moderate cost', con: 'Best default for most histories' },
  { key: 'opus',   label: 'Opus',   pro: 'Deepest reasoning on messy history', con: 'Slowest, priciest, heavy on rate limit' },
] as const

const STATUS_LABEL: Record<string, string> = {
  idle: 'Ready',
  running: 'Scanning',
  done: 'Complete',
  error: 'Scan failed',
}

function sameAutos(a: Auto[], b: Auto[]): boolean {
  return a.length === b.length && a.every((item, i) => {
    const other = b[i]
    if (!other) return false
    return item.id === other.id
      && item.status === other.status
      && item.statusDetail === other.statusDetail
      && item.title === other.title
      && item.description === other.description
      && item.steps.join('\0') === other.steps.join('\0')
      && item.confidence === other.confidence
      && item.evidence.count === other.evidence.count
      && item.suggestedTrigger.label === other.suggestedTrigger.label
      && item.suggestedTrigger.cron === other.suggestedTrigger.cron
      && item.recommendedTier === other.recommendedTier
      && item.selectedTier === other.selectedTier
      && item.generatedArtifactId === other.generatedArtifactId
      && item.generatedArtifactTier === other.generatedArtifactTier
      && item.ruleSuggestion === other.ruleSuggestion
      && JSON.stringify((item as Auto & { ruleApplications?: unknown[] }).ruleApplications ?? [])
        === JSON.stringify((other as Auto & { ruleApplications?: unknown[] }).ruleApplications ?? [])
  })
}

export function DetectView() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState('idle')
  const [logs, setLogs] = useState<Log[]>([])
  const [autos, setAutos] = useState<Auto[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [model, setModel] = useState<ScanModel>(() => readScanModel())
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const [elapsed, setElapsed] = useState(0)
  const [promotionAuto, setPromotionAuto] = useState<Auto | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const activeGeneration = generation && !generationArtifactId(generation) && !generation.error ? generation : null
  // Only treat busyId as "still generating" until its automation reaches a terminal status —
  // otherwise a lingering busyId keeps the header lock-note up after a card already shows cancelled.
  const busyAuto = busyId ? autos.find(a => a.id === busyId) : undefined
  const busyIdActive = busyId && (!busyAuto || busyAuto.status === 'promoting') ? busyId : null
  const activePromotionId = activeGeneration?.id ?? autos.find(a => a.status === 'promoting')?.id ?? busyIdActive
  const generationInProgress = activePromotionId !== null
  const running = status === 'running'
  const latestStep = activeGeneration?.step ?? (logs.length > 0 ? logs[logs.length - 1].message : null)
  const completedArtifactRef = useRef<string | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Live elapsed timer while a workflow is generating — generation can take minutes, so a
  // visibly-ticking clock + current step reassures the user it's working, not hung.
  useEffect(() => {
    if (!activeGeneration) { setElapsed(0); return }
    const started = Date.parse(activeGeneration.startedAt)
    if (!Number.isFinite(started)) { setElapsed(0); return }
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [activeGeneration?.startedAt])

  // Clear this view's busy state on completion. The completion *toast* is fired once,
  // app-wide, by useGenerationWatcher in the shell — firing it here too would double it.
  useEffect(() => {
    const artifactId = generationArtifactId(generation)
    if (!artifactId || completedArtifactRef.current === artifactId) return
    completedArtifactRef.current = artifactId
    setBusyId(null)
  }, [generation?.artifactId, generation?.workflowId])

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
    setScanError(r.error ?? null)
    setGeneration(r.generation ?? null)
    setLogs(prev => mergeScanLogs(prev, r.log ?? []))
    setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    return r
  }

  async function scan() {
    if (running || generationInProgress) return
    setActionError(null)
    setScanError(null)
    setStatus('running'); setLogs([]); setAutos([])
    try {
      const res = await api.automationScan.start(model)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setActionError(body.error || 'Could not start history scan.')
        await refresh()
      }
    } catch {
      setActionError('Could not start history scan — is the server still running?')
      await refresh().catch(() => setStatus('idle'))
    }
  }

  // mount: replay current state, subscribe to live log, optionally autostart
  useEffect(() => {
    const es = new EventSource('/api/automation-scan/stream')
    es.onmessage = (m) => { try { const e = JSON.parse(m.data) as Log; setLogs(prev => mergeScanLogs(prev, [e])) } catch { /* ignore */ } }
    refresh().then(r => {
      const promotionActive = Boolean(r.generation && !generationArtifactId(r.generation) && !r.generation.error) || r.automations.some(a => a.status === 'promoting')
      if (params.get('autostart') === '1' && r.status !== 'running' && !promotionActive && !startedRef.current) {
        startedRef.current = true
        scan()
      }
      if (params.get('autostart')) { params.delete('autostart'); setParams(params, { replace: true }) }
    }).catch(() => {})
    // poll for terminal transition (SSE carries logs, GET carries results + status)
    const poll = setInterval(async () => {
      try {
        const r = await api.automationScan.latest()
        const visibleAutos = r.automations.filter(a => a.status !== 'dismissed')
        setStatus(prev => prev === r.status ? prev : r.status)
        setScanError(prev => prev === (r.error ?? null) ? prev : (r.error ?? null))
        setLogs(prev => mergeScanLogs(prev, r.log ?? []))
        setGeneration(prev => {
          const next = r.generation ?? null
          if (!prev && !next) return prev
          if (prev?.id === next?.id && prev?.step === next?.step && prev?.startedAt === next?.startedAt && prev?.artifactId === next?.artifactId && prev?.workflowId === next?.workflowId && prev?.tier === next?.tier && prev?.error === next?.error) return prev
          return next
        })
        setAutos(prev => sameAutos(prev, visibleAutos) ? prev : visibleAutos)
      } catch { /* keep the current view usable while the API reconnects */ }
    }, 1000)
    return () => { es.close(); clearInterval(poll) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Autoscroll the log to the bottom — scroll the log container itself, not via
  // scrollIntoView, which walks up the ancestor chain and would yank the whole
  // page/results column to the bottom when generation streams new log lines.
  useEffect(() => {
    const el = logEndRef.current?.parentElement
    if (!el) return
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [logs])

  // Promotion spawns Claude for procedural tiers. Guard against double-fire and
  // give visible feedback; block dismiss on the same card while a promote is in flight.
  async function promote(id: string, tier: Exclude<ArtifactTier, 'rule'>): Promise<boolean> {
    if (generationInProgress) return false
    const title = autos.find(a => a.id === id)?.title
    setBusyId(id); setActionError(null)
    setAutos(prev => prev.map(a => a.id === id ? {
      ...a,
      status: 'promoting',
      selectedTier: tier,
      ...(a.generatedArtifactId && !a.generatedArtifactTier
        ? { generatedArtifactTier: a.selectedTier && a.selectedTier !== 'rule' ? a.selectedTier : 'workflow' }
        : {}),
      statusDetail: undefined,
    } : a))
    try {
      const r = await api.automationScan.promote(id, tier)
      if (!mountedRef.current) return false
      if (!r.ok) {
        toast.error(`${artifactTierLabel(tier)} generation failed`, r.error || 'Could not start generation.')
        setActionError(r.error || 'Could not start generation.')
        setBusyId(null)
        return false
      } else {
        toast.success(`${artifactTierLabel(tier)} generation started`, title ? `"${title}" is running in the background` : 'You can leave this page')
      }
      await refresh()
      return true
    } catch {
      if (mountedRef.current) setActionError('Promote failed — is the server still running?')
      if (mountedRef.current) setBusyId(null)
      if (mountedRef.current) await refresh().catch(() => {})
      return false
    } finally { /* busyId clears from persisted generation completion/cancel refresh */ }
  }

  async function confirmPromotion(tier: ArtifactTier, target?: RuleTarget) {
    if (!promotionAuto) return
    setDialogBusy(true)
    if (tier === 'rule') {
      if (!target) { setDialogBusy(false); return }
      try {
        const result = await api.automationScan.applyRule(promotionAuto.id, target)
        setAutos(prev => prev.map(auto => auto.id === result.automation.id ? result.automation : auto))
        setPromotionAuto(null)
        toast.success('Rule added', result.filePath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~'))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not add the rule.'
        setActionError(message)
        toast.error('Rule not added', message)
      } finally {
        setDialogBusy(false)
      }
      return
    }

    const started = await promote(promotionAuto.id, tier)
    if (started) setPromotionAuto(null)
    setDialogBusy(false)
  }

  async function removeRule(id: string, target: RuleTarget) {
    setActionError(null)
    try {
      const result = await api.automationScan.removeRule(id, target)
      setAutos(prev => prev.map(auto => auto.id === result.automation.id ? result.automation : auto))
      toast.success('Rule removed', result.filePath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~'))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not remove the rule.'
      setActionError(message)
      toast.error('Rule not removed', message)
    }
  }
  async function cancelPromote(id: string) {
    setCancelingId(id)
    setActionError(null)
    try {
      const res = await api.automationScan.cancelPromote(id)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setActionError(body.error || 'Could not cancel generation.')
      }
      await refresh()
    } catch {
      setActionError('Cancel failed — is the server still running?')
    } finally {
      if (mountedRef.current) {
        setCancelingId(null)
        setBusyId(null)
      }
    }
  }
  async function dismiss(id: string) {
    if (generationInProgress) return
    const automation = autos.find(candidate => candidate.id === id)
    if (!automation) return
    setActionError(null)
    try {
      const res = await api.automationScan.dismiss(id)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setActionError(body.error || 'Could not dismiss this automation.')
        await refresh()
        return
      }
    } catch {
      setActionError('Dismiss failed — is the server still running?')
      return
    }
    if (mountedRef.current) setAutos(prev => prev.filter(a => a.id !== id))
    toast.info(
      'Automation dismissed',
      `"${automation.title}" was removed from this scan.`,
      { label: 'Undo', onClick: () => { void restoreDismissed(automation) } },
    )
  }

  async function restoreDismissed(automation: Auto) {
    try {
      const res = await api.automationScan.restore(automation.id)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || 'Could not restore this automation.')
      }
      if (mountedRef.current) {
        setActionError(null)
        await refresh()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not restore this automation.'
      if (mountedRef.current) {
        setActionError(message)
        await refresh().catch(() => {})
      }
      toast.error('Undo failed', message)
    }
  }

  const selectedModel = MODELS.find(m => m.key === model) ?? MODELS[1]
  const activeTier = activeGeneration?.tier ?? (activePromotionId ? autos.find(a => a.id === activePromotionId)?.selectedTier : undefined)
  const statusLabel = generationInProgress
    ? `Generating ${artifactTierLabel((activeTier as ArtifactTier | undefined) ?? 'workflow').toLowerCase()}`
    : STATUS_LABEL[status] ?? status
  const statusClass = generationInProgress ? 'promoting' : status
  const scanState = deriveScanUiState(status, autos)
  const resultsContent = detectResultsContent(scanState)

  return (
    <div className="detect">
      <header className="detect__bar">
        <button className="detect__back" type="button" onClick={() => navigate('/')}>Home</button>
        <div className="detect__heading">
          <span className="detect__eyebrow">History scan</span>
          <h1 className="detect__title">Detect automations</h1>
          <p className="detect__subtitle">Find repeated Claude Code work and compile each pattern into the smallest useful artifact.</p>
        </div>
        <div className="detect__bar-actions">
          <span className={`detect__status detect__status--${statusClass}`}>{statusLabel}</span>
          <button
            className="detect__scan"
            type="button"
            onClick={scan}
            disabled={running || generationInProgress}
            title={generationInProgress ? 'An artifact is already being generated.' : undefined}
          >
            {generationInProgress ? 'Generating...' : running ? 'Scanning...' : status === 'idle' ? 'Scan history' : 'Scan again'}
          </button>
        </div>
      </header>
      <div className="detect__models" role="radiogroup" aria-label="Analysis model">
        <span className="detect__models-label">Model</span>
        <div className="detect__model-group">
          {MODELS.map(m => (
            <button
              key={m.key}
              type="button"
              className={`detect__model${model === m.key ? ' detect__model--on' : ''}`}
              onClick={() => {
                setModel(m.key)
                writeScanModel(m.key)
              }}
              disabled={running || generationInProgress}
              title={generationInProgress ? 'Model changes are disabled while an artifact is being generated.' : undefined}
              aria-pressed={model === m.key}
            >
              <span className="detect__model-name">{m.label}</span>
            </button>
          ))}
        </div>
        <span className="detect__model-note">{selectedModel.pro}. {selectedModel.con}.</span>
      </div>
      {generationInProgress && (
        <p className="detect__lock-note" role="status">
          An artifact is generating in the background. Scanning, model changes, and dismiss stay paused until it finishes — you can leave this page.
        </p>
      )}
      <div className="detect__body">
        <main className="detect__results" aria-label="Detected automations">
          <div className="detect__results-head">
            <h2 className="detect__results-h">{resultsContent.title}</h2>
            {resultsContent.detail && <span className="detect__results-sub">{resultsContent.detail}</span>}
          </div>
          {actionError && <p className="detect__error">{actionError}</p>}
          {status === 'error' && scanError && scanError !== actionError && <p className="detect__error">{scanError}</p>}
          {autos.length === 0 ? (
            <div className="detect__empty-state">
              <p className="detect__empty-title">{resultsContent.emptyTitle}</p>
              <p className="detect__empty-copy">{resultsContent.emptyDescription}</p>
            </div>
          ) : (
            <div className="detect__cards">
              {autos.map(a => {
                const failed = a.status === 'promotion_failed'
                const cancelled = a.status === 'promotion_cancelled'
                const promoted = a.status === 'promoted'
                const tier = recommendedTier(a)
                const selectedGenerationTier = a.selectedTier ?? (generation?.id === a.id ? generation.tier : undefined) ?? tier
                const generatedArtifactId = a.generatedArtifactId ?? (generation?.id === a.id ? generationArtifactId(generation) : undefined)
                const generatedArtifactTier = a.generatedArtifactTier
                  ?? (generation?.id === a.id && generationArtifactId(generation) ? generation.tier : undefined)
                  ?? (a.selectedTier && a.selectedTier !== 'rule' ? a.selectedTier : 'workflow')
                const appliedRuleTargets = applicationTargets(a)
                // A card that has reached a terminal state is never "busy", even if busyId /
                // activePromotionId briefly linger after a cancel — otherwise the loading bar
                // renders on top of the cancelled/failed message.
                const busy = !failed && !cancelled && !promoted
                  && (a.status === 'promoting' || busyId === a.id || activePromotionId === a.id)
                return (
                <article
                  key={a.id}
                  className={`detect__card${busy ? ' detect__card--busy' : ''}${failed ? ' detect__card--failed' : ''}`}
                  style={busy ? ({ viewTransitionName: 'detect-morph' } as React.CSSProperties) : undefined}
                >
                  <div className="detect__card-top">
                    <h3 className="detect__card-title">{a.title}</h3>
                    <div className="detect__card-badges">
                      <ArtifactBadge tier={tier} recommended />
                      {a.status === 'promoted' && <span className="detect__badge">{appliedRuleTargets.length > 0 && !generatedArtifactId ? 'Applied' : 'Generated'}</span>}
                      {busy && <span className="detect__badge detect__badge--busy">Generating</span>}
                      {cancelled && <span className="detect__badge detect__badge--muted">Cancelled</span>}
                      {failed && <span className="detect__badge detect__badge--error">Failed</span>}
                    </div>
                  </div>
                  <div className="detect__card-meta">
                    <span>{a.evidence.count} sighting{a.evidence.count === 1 ? '' : 's'}</span>
                    <span>{a.suggestedTrigger.label || 'On demand'}</span>
                    <span>{Math.round(a.confidence * 100)}% confidence</span>
                  </div>
                  {a.recommendedTierReason && (
                    <p className="detect__card-reason">
                      <strong>{artifactTierLabel(tier)}</strong> — {a.recommendedTierReason}
                    </p>
                  )}
                  {a.description && <p className="detect__card-desc">{a.description}</p>}
                  {a.steps.length > 0 && (
                    <ol className="detect__steps">
                      {a.steps.slice(0, 4).map((step, i) => (
                        <li key={`${a.id}-${i}`}>{step}</li>
                      ))}
                    </ol>
                  )}
                  <div className="detect__card-actions">
                    {generatedArtifactId ? (
                      <>
                        <button
                          className="detect__promote"
                          type="button"
                          onClick={() => navigate(`/w/${generatedArtifactId}/build`)}
                        >
                          Open {artifactTierLabel(generatedArtifactTier as ArtifactTier).toLowerCase()}
                        </button>
                        <button
                          className="detect__dismiss"
                          type="button"
                          onClick={() => setPromotionAuto(a)}
                          disabled={generationInProgress}
                        >
                          Generate again
                        </button>
                      </>
                    ) : (
                      <button
                        className="detect__promote"
                        type="button"
                        onClick={() => setPromotionAuto(a)}
                        disabled={generationInProgress}
                        title={generationInProgress && !busy ? 'An artifact is already being generated.' : undefined}
                      >
                        {busy
                          ? `Generating ${artifactTierLabel(selectedGenerationTier as ArtifactTier).toLowerCase()}…`
                          : promoted || failed || cancelled
                            ? appliedRuleTargets.length > 0 && !generatedArtifactId ? 'Add rule elsewhere…' : 'Generate again'
                            : tier === 'rule' ? 'Add rule…' : `Generate ${artifactTierLabel(tier)}`}
                      </button>
                    )}
                    {busy ? (
                      <button className="detect__dismiss detect__cancel" type="button" onClick={() => cancelPromote(a.id)} disabled={cancelingId === a.id}>
                        {cancelingId === a.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    ) : (
                      <button
                        className="detect__dismiss"
                        type="button"
                        onClick={() => dismiss(a.id)}
                        disabled={generationInProgress || appliedRuleTargets.length > 0}
                        title={appliedRuleTargets.length > 0
                          ? 'Remove every applied rule before dismissing this automation.'
                          : generationInProgress ? 'Dismiss is disabled while an artifact is being generated.' : undefined}
                      >Dismiss</button>
                    )}
                    {!busy && appliedRuleTargets.map((target) => (
                      <button
                        key={target.type === 'project-agents' ? `${target.type}:${target.projectDir}` : target.type}
                        className="detect__dismiss detect__cancel"
                        type="button"
                        onClick={() => void removeRule(a.id, target)}
                      >
                        Remove rule
                      </button>
                    ))}
                  </div>
                  {cancelled && a.statusDetail && <p className="detect__card-failed detect__card-muted">{a.statusDetail}</p>}
                  {failed && a.statusDetail && <p className="detect__card-failed">{a.statusDetail}</p>}
                  {busy && (
                    <div className="detect__card-busy">
                      <div className="detect__progress" role="progressbar" aria-label={`Generating ${artifactTierLabel(selectedGenerationTier as ArtifactTier).toLowerCase()}`}>
                        <div className="detect__progress-bar" />
                      </div>
                      <div className="detect__busy-status">
                        <span className="detect__busy-step">{latestStep ?? 'Starting...'}</span>
                        <span className="detect__busy-elapsed" aria-label="Time elapsed">{formatElapsed(elapsed)}</span>
                      </div>
                      <span className="detect__busy-hint">You can leave this page; the result will land in your saved artifacts.</span>
                    </div>
                  )}
                </article>
                )
              })}
            </div>
          )}
        </main>
        <aside className="detect__log-panel" aria-label="Scan log">
          <div className="detect__log-head">
            <h2 className="detect__log-title">Scan log</h2>
            <span className="detect__log-count">{logs.length} events</span>
          </div>
          <section className="detect__log">
            {logs.length === 0 && !running && <p className="detect__empty">Scan events will appear here.</p>}
            {logs.map((l, i) => (
              <div key={i} className={`detect__line detect__line--${l.level}`}>
                <span className="detect__ts">{l.ts ? new Date(l.ts).toLocaleTimeString() : ''}</span>
                <span className="detect__msg">{l.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </section>
        </aside>
      </div>
      <PromotionDialog
        automation={promotionAuto}
        busy={dialogBusy}
        onClose={() => setPromotionAuto(null)}
        onConfirm={(tier, target) => { void confirmPromotion(tier, target) }}
      />
    </div>
  )
}
