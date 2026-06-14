import React, { useState, useEffect } from 'react'
import { api } from '../../lib/api.ts'
import { Term } from '../../components/common/Term.tsx'
import { AutomationModal } from '../../components/automate/AutomationModal.tsx'
import { describeCron } from '../../lib/schedule-cron.ts'
import { Cron } from 'croner'
import type { CwcTrigger } from '../../types.ts'
import type { ModeProps } from '../modeProps.ts'
import './AutomateMode.css'

/** Lifecycle state of a trigger from the user's perspective. */
type LifecycleState = 'draft' | 'off' | 'on'

interface TriggerStatus {
  armed: boolean
  lastFiredAt?: string
  skippedCount: number
  lastSkip?: { ts: string; reason: string }
}

function nextRunPreview(schedule: string): string {
  try {
    const next = new Cron(schedule).nextRun()
    return next ? next.toLocaleString() : 'never matches'
  } catch {
    return ''
  }
}

function lifecycleState(t: CwcTrigger, status: TriggerStatus | undefined): LifecycleState {
  if (!status?.armed) return 'draft'
  return t.enabled ? 'on' : 'off'
}

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  draft: 'Draft',
  off: 'Off',
  on: 'On',
}

export function AutomateMode({ workflow, dispatch }: ModeProps) {
  const triggers = workflow.meta.triggers ?? []
  const [statuses, setStatuses] = useState<Record<string, TriggerStatus>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTrigger, setEditingTrigger] = useState<CwcTrigger | null>(null)

  // Arming confirmation state: trigger awaiting user's trust confirmation
  const [pendingArmId, setPendingArmId] = useState<string | null>(null)

  const triggersKey = JSON.stringify(triggers)

  // Fetch statuses whenever triggers change
  useEffect(() => {
    let alive = true
    if (triggers.length === 0) return
    Promise.all(
      triggers.map(async t => [t.id, await api.automations.triggerStatus(t).catch(() => null)] as const)
    ).then(entries => {
      if (alive) {
        setStatuses(Object.fromEntries(
          entries.filter(([, v]) => v !== null)
        ) as Record<string, TriggerStatus>)
      }
    })
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggersKey])

  function setTriggers(next: CwcTrigger[]) {
    dispatch({ type: 'SET_META', payload: { triggers: next } })
  }

  function updateTrigger(id: string, patch: Partial<CwcTrigger>) {
    setTriggers(triggers.map(t => t.id === id ? { ...t, ...patch } : t))
  }

  function deleteTrigger(id: string) {
    setTriggers(triggers.filter(t => t.id !== id))
  }

  async function armAndEnable(t: CwcTrigger) {
    await api.automations.arm(t)
    setStatuses(s => ({ ...s, [t.id]: { ...(s[t.id] ?? { skippedCount: 0 }), armed: true } }))
    updateTrigger(t.id, { enabled: true })
    setPendingArmId(null)
  }

  function openAdd() {
    setEditingTrigger(null)
    setModalOpen(true)
  }

  function openEdit(t: CwcTrigger) {
    setEditingTrigger(t)
    setModalOpen(true)
  }

  function handleSave(saved: CwcTrigger) {
    const exists = triggers.some(t => t.id === saved.id)
    if (exists) {
      setTriggers(triggers.map(t => t.id === saved.id ? saved : t))
    } else {
      setTriggers([...triggers, saved])
    }
  }

  function triggerSummary(t: CwcTrigger): string {
    if (t.type === 'cron' && t.schedule) return describeCron(t.schedule)
    return 'Webhook'
  }

  return (
    <div className="automate-mode">
      <div className="automate-mode__header">
        <div className="automate-mode__header-text">
          <h2 className="automate-mode__title">Automations</h2>
          <p className="automate-mode__subtitle">
            Schedules and webhooks that run this workflow on their own.
          </p>
        </div>
        <button type="button" className="automate-mode__add-btn" onClick={openAdd}>
          + Add automation
        </button>
      </div>

      {triggers.length === 0 ? (
        <div className="automate-mode__empty">
          <p className="automate-mode__empty-headline">No automations yet.</p>
          <p className="automate-mode__empty-hint">
            Add a schedule or webhook so this workflow can run on its own.
          </p>
          <button type="button" className="automate-mode__add-btn" onClick={openAdd}>
            + Add automation
          </button>
        </div>
      ) : (
        <ul className="automate-mode__list">
          {triggers.map(t => {
            const status = statuses[t.id]
            const state = lifecycleState(t, status)
            const isPendingArm = pendingArmId === t.id

            return (
              <li key={t.id} className={`automate-mode__row automate-mode__row--${state}`}>
                {/* Icon + summary */}
                <span className="automate-mode__row-icon">
                  {t.type === 'cron' ? '⏰' : '🔗'}
                </span>
                <div className="automate-mode__row-body">
                  <span className="automate-mode__row-summary">{triggerSummary(t)}</span>
                  {t.type === 'cron' && t.schedule && state !== 'draft' && (
                    <span className="automate-mode__row-next">
                      Next: {nextRunPreview(t.schedule)}
                    </span>
                  )}
                  {t.type === 'webhook' && (
                    <span className="automate-mode__row-next">
                      POST http://localhost:3579/api/triggers/{t.token}
                    </span>
                  )}
                  {status?.lastFiredAt && (
                    <span className="automate-mode__row-meta">
                      Last fired {new Date(status.lastFiredAt).toLocaleString()}
                    </span>
                  )}
                  {status?.lastSkip && (
                    <span className="automate-mode__row-skip">
                      Last skipped {new Date(status.lastSkip.ts).toLocaleString()} — {status.lastSkip.reason}
                    </span>
                  )}
                </div>

                {/* Lifecycle pill */}
                <span className={`automate-mode__pill automate-mode__pill--${state}`}>
                  {LIFECYCLE_LABEL[state]}
                </span>

                {/* Actions */}
                <div className="automate-mode__row-actions">
                  {/* Turn on: arm if needed, then enable */}
                  {state === 'draft' && (
                    isPendingArm ? (
                      <div className="automate-mode__trust-prompt">
                        <p className="automate-mode__trust-text">
                          Turning this on lets it run commands on your machine
                          {t.type === 'cron' ? ' on schedule' : ' via webhook'}.
                          Confirm you trust this workflow.
                        </p>
                        <div className="automate-mode__trust-btns">
                          <button
                            type="button"
                            className="automate-mode__action-btn automate-mode__action-btn--cancel"
                            onClick={() => setPendingArmId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="automate-mode__action-btn automate-mode__action-btn--confirm"
                            onClick={() => void armAndEnable(t)}
                          >
                            <Term name="arm">Arm</Term> and turn on
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="automate-mode__action-btn automate-mode__action-btn--turn-on"
                        onClick={() => setPendingArmId(t.id)}
                      >
                        Turn on
                      </button>
                    )
                  )}
                  {state === 'off' && (
                    <button
                      type="button"
                      className="automate-mode__action-btn automate-mode__action-btn--turn-on"
                      onClick={() => updateTrigger(t.id, { enabled: true })}
                    >
                      Turn on
                    </button>
                  )}
                  {state === 'on' && (
                    <button
                      type="button"
                      className="automate-mode__action-btn"
                      onClick={() => updateTrigger(t.id, { enabled: false })}
                    >
                      Turn off
                    </button>
                  )}

                  <button
                    type="button"
                    className="automate-mode__action-btn"
                    onClick={() => openEdit(t)}
                    aria-label="Edit automation"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="automate-mode__action-btn automate-mode__action-btn--delete"
                    onClick={() => deleteTrigger(t.id)}
                    aria-label="Delete automation"
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="automate-mode__global-note">
        Automations run when the CWC server is active. Global pause is available from the Home dashboard.
      </p>

      <AutomationModal
        open={modalOpen}
        trigger={editingTrigger}
        onSave={handleSave}
        onClose={() => setModalOpen(false)}
      />
    </div>
  )
}
