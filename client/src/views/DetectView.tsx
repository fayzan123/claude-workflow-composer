import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.ts'
import { toast } from '../lib/toast.ts'
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

/** Merge log entries, deduped by ts+level+message, so GET-replay and live SSE can't drop or double a line regardless of arrival order. */
function mergeLogs(prev: Log[], incoming: Log[]): Log[] {
  if (incoming.length === 0) return prev
  const key = (l: Log) => `${l.ts}|${l.level}|${l.message}`
  const seen = new Set(prev.map(key))
  const added = incoming.filter(l => !seen.has(key(l)))
  if (added.length === 0) return prev
  return [...prev, ...added].sort((a, b) => {
    const at = Date.parse(a.ts)
    const bt = Date.parse(b.ts)
    if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0
    if (!Number.isFinite(at)) return 1
    if (!Number.isFinite(bt)) return -1
    return at - bt
  })
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
  const [model, setModel] = useState<string>('sonnet')
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const [elapsed, setElapsed] = useState(0)
  const activeGeneration = generation && !generation.workflowId && !generation.error ? generation : null
  // Only treat busyId as "still generating" until its automation reaches a terminal status —
  // otherwise a lingering busyId keeps the header lock-note up after a card already shows cancelled.
  const busyAuto = busyId ? autos.find(a => a.id === busyId) : undefined
  const busyIdActive = busyId && (!busyAuto || busyAuto.status === 'promoting') ? busyId : null
  const activePromotionId = activeGeneration?.id ?? autos.find(a => a.status === 'promoting')?.id ?? busyIdActive
  const generationInProgress = activePromotionId !== null
  const running = status === 'running'
  const latestStep = activeGeneration?.step ?? (logs.length > 0 ? logs[logs.length - 1].message : null)
  const completedWorkflowRef = useRef<string | null>(null)
  useEffect(() => () => { mountedRef.current = false }, [])

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
    if (!generation?.workflowId || completedWorkflowRef.current === generation.workflowId) return
    completedWorkflowRef.current = generation.workflowId
    setBusyId(null)
  }, [generation?.workflowId])

  // Prominent toast when a history scan finishes (the small status pill is easy to miss).
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev === 'running' && status === 'done') {
      const n = autos.length
      toast.success('History scan complete', n > 0 ? `${n} automation${n === 1 ? '' : 's'} found` : 'No strong patterns found this time')
    } else if (prev === 'running' && status === 'error') {
      toast.error('History scan failed', 'See the scan log for details.')
    }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
    setGeneration(r.generation ?? null)
    setLogs(prev => mergeLogs(prev, r.log ?? []))
    setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    return r
  }

  async function scan() {
    if (running || generationInProgress) return
    setActionError(null)
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
    es.onmessage = (m) => { try { const e = JSON.parse(m.data) as Log; setLogs(prev => mergeLogs(prev, [e])) } catch { /* ignore */ } }
    refresh().then(r => {
      const promotionActive = Boolean(r.generation && !r.generation.workflowId && !r.generation.error) || r.automations.some(a => a.status === 'promoting')
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
        setGeneration(prev => {
          const next = r.generation ?? null
          if (!prev && !next) return prev
          if (prev?.id === next?.id && prev?.step === next?.step && prev?.startedAt === next?.startedAt && prev?.workflowId === next?.workflowId && prev?.error === next?.error) return prev
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
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [logs])

  // Promote spawns Claude to generate the workflow (seconds). Guard against double-fire and
  // give visible feedback; block dismiss on the same card while a promote is in flight.
  async function promote(id: string) {
    if (generationInProgress) return
    const title = autos.find(a => a.id === id)?.title
    setBusyId(id); setActionError(null)
    setAutos(prev => prev.map(a => a.id === id ? { ...a, status: 'promoting', statusDetail: undefined } : a))
    try {
      const r = await api.automationScan.promote(id)
      if (!mountedRef.current) return
      if (!r.ok) {
        toast.error('Workflow generation failed', r.error || 'Could not start workflow generation.')
        setActionError(r.error || 'Could not start workflow generation.')
        setBusyId(null)
      } else {
        toast.success('Workflow generation started', title ? `"${title}" is running in the background` : 'You can leave this page')
      }
      await refresh()
    } catch {
      if (mountedRef.current) setActionError('Promote failed — is the server still running?')
      if (mountedRef.current) setBusyId(null)
      if (mountedRef.current) await refresh().catch(() => {})
    } finally { /* busyId clears from persisted generation completion/cancel refresh */ }
  }
  async function cancelPromote(id: string) {
    setCancelingId(id)
    setActionError(null)
    try {
      const res = await api.automationScan.cancelPromote(id)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setActionError(body.error || 'Could not cancel workflow generation.')
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
    setAutos(prev => prev.filter(a => a.id !== id))
  }

  const selectedModel = MODELS.find(m => m.key === model) ?? MODELS[1]
  const statusLabel = generationInProgress ? 'Generating workflow' : STATUS_LABEL[status] ?? status
  const statusClass = generationInProgress ? 'promoting' : status

  return (
    <div className="detect">
      <header className="detect__bar">
        <button className="detect__back" type="button" onClick={() => navigate('/')}>Home</button>
        <div className="detect__heading">
          <span className="detect__eyebrow">History scan</span>
          <h1 className="detect__title">Detect automations</h1>
          <p className="detect__subtitle">Find repeated Claude Code work and turn the strongest patterns into workflows.</p>
        </div>
        <div className="detect__bar-actions">
          <span className={`detect__status detect__status--${statusClass}`}>{statusLabel}</span>
          <button
            className="detect__scan"
            type="button"
            onClick={scan}
            disabled={running || generationInProgress}
            title={generationInProgress ? 'A workflow is already being generated.' : undefined}
          >
            {generationInProgress ? 'Generating...' : running ? 'Scanning...' : logs.length ? 'Scan again' : 'Scan history'}
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
              onClick={() => setModel(m.key)}
              disabled={running || generationInProgress}
              title={generationInProgress ? 'Model changes are disabled while a workflow is being generated.' : undefined}
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
          A workflow is generating in the background. Scanning, model changes, and dismiss stay paused until it finishes — you can leave this page.
        </p>
      )}
      <div className="detect__body">
        <main className="detect__results" aria-label="Detected automations">
          <div className="detect__results-head">
            <h2 className="detect__results-h">{autos.length > 0 ? `${autos.length} automation${autos.length === 1 ? '' : 's'} found` : 'Automation candidates'}</h2>
            {running && <span className="detect__results-sub">Reading history and clustering repeat work</span>}
          </div>
          {actionError && <p className="detect__error">{actionError}</p>}
          {autos.length === 0 ? (
            <div className="detect__empty-state">
              <p className="detect__empty-title">
                {running ? 'Looking for repeatable work' : status === 'done' ? 'No strong patterns found' : 'Start with a history scan'}
              </p>
              <p className="detect__empty-copy">
                {running
                  ? 'Candidates will appear here as soon as the scan finishes.'
                  : status === 'done'
                    ? 'Try a deeper model later if your recent history is sparse or messy.'
                    : 'CWC will inspect your local Claude Code history, cluster repeated work, and show the workflows worth generating.'}
              </p>
            </div>
          ) : (
            <div className="detect__cards">
              {autos.map(a => {
                const failed = a.status === 'promotion_failed'
                const cancelled = a.status === 'promotion_cancelled'
                const promoted = a.status === 'promoted'
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
                    {a.status === 'promoted' && <span className="detect__badge">Promoted</span>}
                    {busy && <span className="detect__badge detect__badge--busy">Generating</span>}
                    {cancelled && <span className="detect__badge detect__badge--muted">Cancelled</span>}
                    {failed && <span className="detect__badge detect__badge--error">Failed</span>}
                  </div>
                  <div className="detect__card-meta">
                    <span>{a.evidence.count} sighting{a.evidence.count === 1 ? '' : 's'}</span>
                    <span>{a.suggestedTrigger.label || 'On demand'}</span>
                    <span>{Math.round(a.confidence * 100)}% confidence</span>
                  </div>
                  {a.description && <p className="detect__card-desc">{a.description}</p>}
                  {a.steps.length > 0 && (
                    <ol className="detect__steps">
                      {a.steps.slice(0, 4).map((step, i) => (
                        <li key={`${a.id}-${i}`}>{step}</li>
                      ))}
                    </ol>
                  )}
                  <div className="detect__card-actions">
                    <button
                      className="detect__promote"
                      type="button"
                      onClick={() => promote(a.id)}
                      disabled={generationInProgress}
                      title={generationInProgress && !busy ? 'A workflow is already being generated.' : undefined}
                    >
                      {busy ? 'Generating...' : a.status === 'promoted' || failed || cancelled ? 'Generate again' : 'Generate workflow'}
                    </button>
                    {busy ? (
                      <button className="detect__dismiss detect__cancel" type="button" onClick={() => cancelPromote(a.id)} disabled={cancelingId === a.id}>
                        {cancelingId === a.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    ) : (
                      <button
                        className="detect__dismiss"
                        type="button"
                        onClick={() => dismiss(a.id)}
                        disabled={generationInProgress}
                        title={generationInProgress ? 'Dismiss is disabled while a workflow is being generated.' : undefined}
                      >Dismiss</button>
                    )}
                  </div>
                  {cancelled && a.statusDetail && <p className="detect__card-failed detect__card-muted">{a.statusDetail}</p>}
                  {failed && a.statusDetail && <p className="detect__card-failed">{a.statusDetail}</p>}
                  {busy && (
                    <div className="detect__card-busy">
                      <div className="detect__progress" role="progressbar" aria-label="Generating workflow">
                        <div className="detect__progress-bar" />
                      </div>
                      <div className="detect__busy-status">
                        <span className="detect__busy-step">{latestStep ?? 'Starting...'}</span>
                        <span className="detect__busy-elapsed" aria-label="Time elapsed">{formatElapsed(elapsed)}</span>
                      </div>
                      <span className="detect__busy-hint">You can leave this page; the result will land in your workflows.</span>
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
    </div>
  )
}
