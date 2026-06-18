import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.ts'
import './DetectView.css'

type Latest = Awaited<ReturnType<typeof api.automationScan.latest>>
type Auto = Latest['automations'][number]
type Log = NonNullable<Latest['log']>[number]

const MODELS = [
  { key: 'haiku',  label: 'Haiku',  pro: 'Fastest & cheapest', con: 'May miss subtler patterns' },
  { key: 'sonnet', label: 'Sonnet · rec', pro: 'Balanced — strong clustering, low cost', con: 'Best default for most histories' },
  { key: 'opus',   label: 'Opus',   pro: 'Deepest reasoning on messy history', con: 'Slowest, priciest, heavy on rate limit' },
] as const

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
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // Warn before a browser-level close/refresh while a workflow is generating.
  useEffect(() => {
    if (!busyId) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [busyId])

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
    setLogs(prev => mergeLogs(prev, r.log ?? []))
    setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    return r
  }

  async function scan() {
    setStatus('running'); setLogs([]); setAutos([])
    await api.automationScan.start(model)
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
    if (busyId) return
    setBusyId(id); setActionError(null)
    try {
      const r = await api.automationScan.promote(id)
      // If the user navigated away while generating, the workflow is still saved
      // server-side and appears in their library — just don't yank them back here.
      if (!mountedRef.current) return
      if (r.workflowId) { navigate(`/w/${r.workflowId}/build`); return }
      setActionError(r.error || 'Could not generate a workflow from this automation.')
    } catch {
      if (mountedRef.current) setActionError('Promote failed — is the server still running?')
    } finally {
      if (mountedRef.current) setBusyId(null)
    }
  }
  async function dismiss(id: string) {
    if (busyId) return
    try { await api.automationScan.dismiss(id) } catch { /* best effort */ }
    setAutos(prev => prev.filter(a => a.id !== id))
  }

  const running = status === 'running'
  return (
    <div className="detect">
      <header className="detect__bar">
        <button className="detect__back" type="button" onClick={() => navigate('/')}>← Home</button>
        <h1 className="detect__title">Detect automations</h1>
        <button className="detect__scan" type="button" onClick={scan} disabled={running}>
          {running ? 'Scanning…' : logs.length ? 'Re-scan' : 'Scan my history'}
        </button>
      </header>
      <div className="detect__models" role="radiogroup" aria-label="Analysis model">
        <span className="detect__models-label">Analyze with</span>
        {MODELS.map(m => (
          <button
            key={m.key}
            type="button"
            className={`detect__model${model === m.key ? ' detect__model--on' : ''}`}
            onClick={() => setModel(m.key)}
            disabled={running}
            aria-pressed={model === m.key}
          >
            <span className="detect__model-name">{m.label}</span>
            <span className="detect__model-pro">+ {m.pro}</span>
            <span className="detect__model-con">− {m.con}</span>
          </button>
        ))}
      </div>
      <div className="detect__body">
        <section className="detect__log" aria-label="Scan log">
          {logs.length === 0 && !running && <p className="detect__empty">Click "Scan my history" to deeply analyze your Claude Code history.</p>}
          {logs.map((l, i) => (
            <div key={i} className={`detect__line detect__line--${l.level}`}>
              <span className="detect__ts">{l.ts ? new Date(l.ts).toLocaleTimeString() : ''}</span>
              <span className="detect__msg">{l.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </section>
        <aside className="detect__results" aria-label="Detected automations">
          <h2 className="detect__results-h">{autos.length > 0 ? `${autos.length} detected` : 'Results'}</h2>
          {actionError && <p className="detect__error">{actionError}</p>}
          {autos.map(a => {
            const busy = busyId === a.id
            return (
            <div key={a.id} className={`detect__card${busy ? ' detect__card--busy' : ''}`}>
              <div className="detect__card-title">
                {a.title}
                {a.status === 'promoted' && <span className="detect__badge">✓ Promoted</span>}
              </div>
              <div className="detect__card-meta">seen {a.evidence.count}× · {a.suggestedTrigger.label || 'on demand'}</div>
              <div className="detect__card-actions">
                <button type="button" onClick={() => promote(a.id)} disabled={busyId !== null}>
                  {busy ? 'Generating…' : a.status === 'promoted' ? 'Promote again' : 'Promote ▸'}
                </button>
                <button type="button" onClick={() => dismiss(a.id)} disabled={busyId !== null}>Dismiss</button>
              </div>
              {busy && <div className="detect__card-busy">Building agents &amp; wiring the graph — this takes a few moments. You can leave; it keeps generating and lands in your workflows.</div>}
            </div>
            )
          })}
          {status === 'done' && autos.length === 0 && <p className="detect__empty">No recurring automations found.</p>}
        </aside>
      </div>
    </div>
  )
}
