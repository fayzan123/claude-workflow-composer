import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.ts'
import './DetectView.css'

type Latest = Awaited<ReturnType<typeof api.automationScan.latest>>
type Auto = Latest['automations'][number]
type Log = NonNullable<Latest['log']>[number]

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

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
    setLogs(prev => mergeLogs(prev, r.log ?? []))
    setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    return r
  }

  async function scan() {
    setStatus('running'); setLogs([]); setAutos([])
    await api.automationScan.start()
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

  async function promote(id: string) {
    const r = await api.automationScan.promote(id)
    if (r.workflowId) navigate(`/w/${r.workflowId}/build`)
  }
  async function dismiss(id: string) {
    await api.automationScan.dismiss(id)
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
          {autos.map(a => (
            <div key={a.id} className="detect__card">
              <div className="detect__card-title">{a.title}</div>
              <div className="detect__card-meta">seen {a.evidence.count}× · {a.suggestedTrigger.label || 'manual'}</div>
              <div className="detect__card-actions">
                <button type="button" onClick={() => promote(a.id)}>Promote ▸</button>
                <button type="button" onClick={() => dismiss(a.id)}>Dismiss</button>
              </div>
            </div>
          ))}
          {status === 'done' && autos.length === 0 && <p className="detect__empty">No recurring automations found.</p>}
        </aside>
      </div>
    </div>
  )
}
