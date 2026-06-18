import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'

type Auto = Awaited<ReturnType<typeof api.automationScan.latest>>['automations'][number]

export function DetectedAutomations() {
  const navigate = useNavigate()
  const [autos, setAutos] = useState<Auto[]>([])
  const [status, setStatus] = useState<string>('idle')
  const [progress, setProgress] = useState<string>('')
  const [showAll, setShowAll] = useState(false)

  async function refresh() {
    const r = await api.automationScan.latest()
    setStatus(r.status)
    setAutos(r.automations.filter(a => a.status !== 'dismissed'))
  }
  useEffect(() => { refresh().catch(() => {}) }, [])

  async function scan() {
    setStatus('running'); setProgress('starting…')
    const es = new EventSource('/api/automation-scan/stream')
    es.onmessage = (m) => { try { const p = JSON.parse(m.data); setProgress(p.detail ? `${p.stage} · ${p.detail}` : p.stage) } catch { /* ignore */ } }
    await api.automationScan.start()
    const poll = setInterval(async () => {
      const r = await api.automationScan.latest()
      if (r.status === 'done' || r.status === 'error') {
        clearInterval(poll); es.close(); setStatus(r.status)
        setAutos(r.automations.filter(a => a.status !== 'dismissed'))
      }
    }, 500)
  }

  async function promote(id: string) {
    const r = await api.automationScan.promote(id)
    if (r.workflowId) navigate(`/w/${r.workflowId}/build`)
  }
  async function dismiss(id: string) {
    await api.automationScan.dismiss(id)
    setAutos(prev => prev.filter(a => a.id !== id))
  }

  const high = autos.filter(a => a.confidence >= 0.6)
  const low = autos.filter(a => a.confidence < 0.6)
  const visible = showAll ? autos : high

  return (
    <div className="hd-widget">
      <div className="hd-widget__head">
        <h2 className="hd-widget__heading">Detected automations</h2>
        <button className="hd-scan-btn" type="button" onClick={scan} disabled={status === 'running'}>
          {status === 'running' ? 'Scanning…' : 'Scan my history'}
        </button>
      </div>
      {status === 'running' && <p className="hd-candidates__note">{progress || 'reading sessions…'}</p>}
      {visible.length === 0 && status !== 'running' && (
        <p className="hd-candidates__note">No recurring automations detected yet. Run a scan to analyze your Claude history.</p>
      )}
      <ul className="hd-candidates" role="list">
        {visible.map(a => (
          <li key={a.id} className="hd-candidates__item">
            <span className="hd-candidates__summary">{a.title}</span>
            <span className="hd-candidates__meta">seen {a.evidence.count}× · {a.suggestedTrigger.label || 'manual'}</span>
            <div className="hd-candidates__actions">
              <button type="button" onClick={() => promote(a.id)}>Promote ▸</button>
              <button type="button" onClick={() => dismiss(a.id)}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
      {!showAll && low.length > 0 && (
        <button className="hd-candidates__more" type="button" onClick={() => setShowAll(true)}>
          Show {low.length} lower-confidence
        </button>
      )}
      <p className="hd-candidates__note">Read-only until you Promote. Reads are local; analysis runs through your own Claude.</p>
    </div>
  )
}
