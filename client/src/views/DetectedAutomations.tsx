import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'

type Auto = Awaited<ReturnType<typeof api.automationScan.latest>>['automations'][number]

export function DetectedAutomations() {
  const navigate = useNavigate()
  const [autos, setAutos] = useState<Auto[]>([])

  useEffect(() => {
    api.automationScan.latest()
      .then(r => setAutos(r.automations.filter(a => a.status !== 'dismissed')))
      .catch(() => {})
  }, [])

  const high = autos.filter(a => a.confidence >= 0.6).slice(0, 5)
  return (
    <div className="hd-widget">
      <div className="hd-widget__head">
        <h2 className="hd-widget__heading">Detected automations</h2>
        <button className="hd-scan-btn" type="button" onClick={() => navigate('/detect?autostart=1')}>
          Scan my history
        </button>
      </div>
      {high.length === 0 ? (
        <p className="hd-candidates__note">Scan your Claude Code history to detect repeated work worth automating.</p>
      ) : (
        <>
          <ul className="hd-candidates" role="list">
            {high.map(a => (
              <li key={a.id} className="hd-candidates__item">
                <span className="hd-candidates__summary">{a.title}</span>
                <span className="hd-candidates__meta">seen {a.evidence.count}× · {a.suggestedTrigger.label || 'manual'}</span>
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
