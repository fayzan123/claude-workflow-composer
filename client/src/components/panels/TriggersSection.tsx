import React, { useEffect, useState } from 'react'
import { Cron } from 'croner'
import type { CwcFile, CwcTrigger } from '../../types.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import { api } from '../../lib/api.ts'
import { FieldHint } from '../common/FieldHint.tsx'
import { Term } from '../common/Term.tsx'
import { newTrigger } from '../../lib/trigger.ts'
import './TriggersSection.css'

interface Props { workflow: CwcFile; dispatch: React.Dispatch<WorkflowAction> }

function nextRunPreview(schedule: string): string {
  try {
    const next = new Cron(schedule).nextRun()
    return next ? `next: ${next.toLocaleString()}` : 'never matches'
  } catch { return 'invalid cron expression' }
}

interface TriggerStatus { armed: boolean; lastFiredAt?: string; skippedCount: number; lastSkip?: { ts: string; reason: string } }

export function TriggersSection({ workflow, dispatch }: Props) {
  const triggers = workflow.meta.triggers ?? []
  const [statuses, setStatuses] = useState<Record<string, TriggerStatus>>({})

  const triggersKey = JSON.stringify(triggers)
  useEffect(() => {
    let alive = true
    Promise.all(triggers.map(async t => [t.id, await api.automations.triggerStatus(t).catch(() => null)] as const))
      .then(entries => { if (alive) setStatuses(Object.fromEntries(entries.filter(([, v]) => v)) as Record<string, TriggerStatus>) })
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggersKey])

  function setTriggers(next: CwcTrigger[]) {
    dispatch({ type: 'SET_META', payload: { triggers: next } })
  }
  function update(id: string, patch: Partial<CwcTrigger>) {
    setTriggers(triggers.map(t => (t.id === id ? { ...t, ...patch } : t)))
  }

  async function arm(t: CwcTrigger) {
    await api.automations.arm(t)
    setStatuses(s => ({ ...s, [t.id]: { ...(s[t.id] ?? { skippedCount: 0 }), armed: true } }))
  }

  return (
    <section className="triggers-section">
      <h4>Triggers</h4>
      {triggers.length === 0 && <p className="triggers-section__empty">No triggers — this workflow only runs manually.</p>}
      {triggers.map(t => {
        const st = statuses[t.id]
        return (
          <div key={t.id} className={`triggers-section__card ${t.enabled ? '' : 'triggers-section__card--off'}`}>
            <header className="triggers-section__card-header">
              <span>{t.type === 'cron' ? '⏰ Schedule' : '⚡ Webhook'}</span>
              <label className="triggers-section__inline-label"><input type="checkbox" checked={t.enabled} onChange={e => update(t.id, { enabled: e.target.checked })} /> enabled</label>
              <button type="button" onClick={() => setTriggers(triggers.filter(x => x.id !== t.id))} aria-label="Delete trigger">🗑</button>
            </header>

            {t.type === 'cron' && (
              <label className="triggers-section__field"><Term name="cron">cron</Term> expression
                <FieldHint id="trigger.schedule" />
                <input className="triggers-section__input" value={t.schedule ?? ''} onChange={e => update(t.id, { schedule: e.target.value })} />
                <small className="triggers-section__hint">{nextRunPreview(t.schedule ?? '')}</small>
              </label>
            )}
            {t.type === 'webhook' && (
              <label className="triggers-section__field"><Term name="webhook">webhook</Term> URL
                <code className="triggers-section__code">POST http://localhost:3579/api/triggers/{t.token}</code>
                <span className="triggers-section__btn-row">
                  <button type="button" className="triggers-section__btn" onClick={() => navigator.clipboard.writeText(`http://localhost:3579/api/triggers/${t.token}`)}>Copy</button>
                  <button type="button" className="triggers-section__btn" onClick={() => update(t.id, { token: crypto.randomUUID() })}>Regenerate token</button>
                </span>
              </label>
            )}

            <label className="triggers-section__field">Working directory
              <FieldHint id="trigger.cwd" />
              <input className="triggers-section__input" value={t.cwd} onChange={e => update(t.id, { cwd: e.target.value })} placeholder="/absolute/path/to/project" />
            </label>
            <label className="triggers-section__field">Isolation
              <select className="triggers-section__select" value={t.isolation} onChange={e => update(t.id, { isolation: e.target.value as CwcTrigger['isolation'] })}>
                <option value="worktree">worktree (isolated branch — recommended for git repos)</option>
                <option value="in-place">in place</option>
              </select>
            </label>
            {t.isolation === 'worktree' && (
              <label className="triggers-section__field">Base ref <input className="triggers-section__input" value={t.baseRef ?? ''} onChange={e => update(t.id, { baseRef: e.target.value || undefined })} placeholder="HEAD (or e.g. main)" /></label>
            )}
            <label className="triggers-section__field">Precondition (optional, shell — non-zero exit skips the run)
              <FieldHint id="trigger.precondition" />
              <input className="triggers-section__input" value={t.precondition ?? ''} onChange={e => update(t.id, { precondition: e.target.value || undefined })} placeholder='test -n "$(gh pr list --json number -q .)"' />
            </label>
            <label className="triggers-section__field">Setup command (optional, shell — runs before Claude)
              <FieldHint id="trigger.setupCommand" />
              <input className="triggers-section__input" value={t.setupCommand ?? ''} onChange={e => update(t.id, { setupCommand: e.target.value || undefined })} />
            </label>
            {t.type === 'cron' && (
              <label className="triggers-section__inline-label"><input type="checkbox" checked={t.catchUp} onChange={e => update(t.id, { catchUp: e.target.checked })} /> catch up if missed (laptop was asleep)</label>
            )}
            <label className="triggers-section__field">Max runs per day <input className="triggers-section__input triggers-section__input--number" type="number" min={0} value={t.maxRunsPerDay} onChange={e => update(t.id, { maxRunsPerDay: Number(e.target.value) })} /></label>

            <footer className="triggers-section__card-footer">
              {st?.armed
                ? <span className="triggers-section__armed">✓ armed</span>
                : <button type="button" className="triggers-section__arm" onClick={() => void arm(t)} title="Commands in this trigger run on your machine — arming confirms you trust them"><Term name="arm">Arm</Term> trigger</button>}
              {st?.lastFiredAt && <small className="triggers-section__hint">last fired {new Date(st.lastFiredAt).toLocaleString()}</small>}
              {st?.lastSkip && <small className="triggers-section__hint">last skip: {st.lastSkip.reason}</small>}
            </footer>
          </div>
        )
      })}
      <div className="triggers-section__add">
        <button type="button" className="triggers-section__btn" onClick={() => setTriggers([...triggers, newTrigger('cron')])}>+ Schedule</button>
        <button type="button" className="triggers-section__btn" onClick={() => setTriggers([...triggers, newTrigger('webhook')])}>+ Webhook</button>
      </div>
    </section>
  )
}
