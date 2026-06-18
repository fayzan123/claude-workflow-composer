import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'

type Auto = Awaited<ReturnType<typeof api.automationScan.latest>>['automations'][number]

export function DetectedAutomations() {
  const navigate = useNavigate()
  const [autos, setAutos] = useState<Auto[]>([])
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const r = await api.automationScan.latest()
        if (alive) setAutos(r.automations.filter(a => a.status !== 'dismissed'))
      } catch { /* ignore */ }
    }
    load()
    const interval = setInterval(load, 1500)
    return () => { alive = false; clearInterval(interval) }
  }, [])

  async function cancelPromote(id: string) {
    setCancelingId(id)
    try {
      await api.automationScan.cancelPromote(id)
      const r = await api.automationScan.latest()
      setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    } catch { /* Detect tab shows the detailed error state */ }
    finally { setCancelingId(null) }
  }

  const active = autos.find(a => a.status === 'promoting') ?? null
  const high = autos.filter(a => a.confidence >= 0.6 && a.id !== active?.id).slice(0, active ? 4 : 5)
  const visible = active ? [active, ...high] : high
  return (
    <div className="hd-widget">
      <div className="hd-widget__head">
        <h2 className="hd-widget__heading">Detected automations</h2>
        <button className="hd-scan-btn" type="button" onClick={() => navigate(active ? '/detect' : '/detect?autostart=1')}>
          {active ? 'Open Detect' : 'Scan my history'}
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="hd-candidates__note">Scan your Claude Code history to detect repeated work worth automating.</p>
      ) : (
        <>
          <ul className="hd-candidates" role="list">
            {visible.map(a => (
              <li key={a.id} className={`hd-candidates__item${a.status === 'promoting' ? ' hd-candidates__item--busy' : ''}`}>
                <button className="hd-candidates__main" type="button" onClick={() => navigate('/detect')}>
                  <span className="hd-candidates__summary">{a.title}</span>
                  <span className="hd-candidates__meta">
                    {a.status === 'promoting' ? 'Generating workflow' : `seen ${a.evidence.count}× · ${a.suggestedTrigger.label || 'manual'}`}
                  </span>
                </button>
                {a.status === 'promoting' && (
                  <div className="hd-candidates__busy">
                    <div className="hd-candidates__progress" role="progressbar" aria-label="Generating workflow">
                      <div className="hd-candidates__progress-bar" />
                    </div>
                    <button className="hd-candidates__cancel" type="button" onClick={() => cancelPromote(a.id)} disabled={cancelingId === a.id}>
                      {cancelingId === a.id ? 'Cancelling...' : 'Cancel'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button className="hd-candidates__more" type="button" onClick={() => navigate('/detect')}>
            Open Detect tab
          </button>
        </>
      )}
    </div>
  )
}
