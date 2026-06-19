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

/** Merge log entries, deduped by ts+message, so GET-replay and live SSE can't drop or double a line regardless of arrival order. */
function mergeLogs(prev: Log[], incoming: Log[]): Log[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map(l => `${l.ts}|${l.message}`))
  const added = incoming.filter(l => !seen.has(`${l.ts}|${l.message}`))
  return added.length === 0 ? prev : [...prev, ...added]
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
  const [actionError, setActionError] = useState<string | null>(null)
  const [model, setModel] = useState<string>('sonnet')
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const [elapsed, setElapsed] = useState(0)
  const activePromotionId = autos.find(a => a.status === 'promoting')?.id ?? busyId
  const generationInProgress = activePromotionId !== null
  const running = status === 'running'
  const latestStep = logs.length > 0 ? logs[logs.length - 1].message : null
  useEffect(() => () => { mountedRef.current = false }, [])

  // Live elapsed timer while a workflow is generating — generation can take minutes, so a
  // visibly-ticking clock + current step reassures the user it's working, not hung.
  useEffect(() => {
    if (!generationInProgress) { setElapsed(0); return }
    const start = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [generationInProgress])

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

  // Warn before a browser-level close/refresh while a workflow is generating.
  useEffect(() => {
    if (!generationInProgress) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [generationInProgress])

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
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
      if (params.get('autostart') === '1' && r.status !== 'running' && !startedRef.current) {
        startedRef.current = true
        scan()
      }
      if (params.get('autostart')) { params.delete('autostart'); setParams(params, { replace: true }) }
    }).catch(() => {})
    // poll for terminal transition (SSE carries logs, GET carries results + status)
    const poll = setInterval(async () => {
      const r = await api.automationScan.latest()
      if (r.status === 'done' || r.status === 'error') { setStatus(r.status); setAutos(r.automations.filter(a => a.status !== 'dismissed')) }
    }, 1000)
    return () => { es.close(); clearInterval(poll) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // autoscroll log to bottom
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  // Promote spawns Claude to generate the workflow (seconds). Guard against double-fire and
  // give visible feedback; block dismiss on the same card while a promote is in flight.
  async function promote(id: string) {
    if (generationInProgress) return
    const title = autos.find(a => a.id === id)?.title
    setBusyId(id); setActionError(null)
    setAutos(prev => prev.map(a => a.id === id ? { ...a, status: 'promoting', statusDetail: undefined } : a))
    try {
      const r = await api.automationScan.promote(id)
      // The workflow is saved server-side regardless of navigation; fire the toast before any
      // early-return so it shows even if the user has navigated away (Toaster is app-level).
      if (r.workflowId) toast.success('Workflow generated', title ? `"${title}" is ready to open` : 'Opening it now')
      // If the user navigated away while generating, the workflow still landed in their library —
      // just don't yank them back here.
      if (!mountedRef.current) return
      if (r.workflowId) { navigate(`/w/${r.workflowId}/build`); return }
      if (r.cancelled) { await refresh(); return }
      toast.error('Workflow generation failed', r.error || 'Could not generate a workflow from this automation.')
      setActionError(r.error || 'Could not generate a workflow from this automation.')
      await refresh()
    } catch {
      if (mountedRef.current) setActionError('Promote failed — is the server still running?')
      if (mountedRef.current) await refresh().catch(() => {})
    } finally {
      if (mountedRef.current) setBusyId(null)
    }
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
          <button className="detect__scan" type="button" onClick={scan} disabled={running || generationInProgress}>
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
              aria-pressed={model === m.key}
            >
              <span className="detect__model-name">{m.label}</span>
            </button>
          ))}
        </div>
        <span className="detect__model-note">{selectedModel.pro}. {selectedModel.con}.</span>
      </div>
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
                const busy = a.status === 'promoting' || busyId === a.id
                const failed = a.status === 'promotion_failed'
                const cancelled = a.status === 'promotion_cancelled'
                return (
                <article key={a.id} className={`detect__card${busy ? ' detect__card--busy' : ''}${failed ? ' detect__card--failed' : ''}`}>
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
                    <button className="detect__promote" type="button" onClick={() => promote(a.id)} disabled={generationInProgress}>
                      {busy ? 'Generating...' : a.status === 'promoted' || failed || cancelled ? 'Generate again' : 'Generate workflow'}
                    </button>
                    {busy ? (
                      <button className="detect__dismiss detect__cancel" type="button" onClick={() => cancelPromote(a.id)} disabled={cancelingId === a.id}>
                        {cancelingId === a.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    ) : (
                      <button className="detect__dismiss" type="button" onClick={() => dismiss(a.id)} disabled={generationInProgress}>Dismiss</button>
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
                        <span className="detect__busy-step">{latestStep ?? 'Starting…'}</span>
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
