import React, { useState, useEffect } from 'react'
import { Cron } from 'croner'
import { Modal } from '../common/Modal.tsx'
import { FieldHint } from '../common/FieldHint.tsx'
import { Term } from '../common/Term.tsx'
import {
  scheduleToCron,
  cronToSchedule,
  describeCron,
  type Frequency,
  type Schedule,
} from '../../lib/schedule-cron.ts'
import type { CwcTrigger } from '../../types.ts'
import './AutomationModal.css'

export interface AutomationModalProps {
  open: boolean
  trigger: CwcTrigger | null   // null = creating new (shows type chooser)
  onSave: (trigger: CwcTrigger) => void
  onClose: () => void
}

function newTrigger(type: CwcTrigger['type']): CwcTrigger {
  return {
    id: `trig-${crypto.randomUUID().slice(0, 8)}`,
    type,
    schedule: type === 'cron' ? '0 9 * * 1-5' : undefined,
    token: type === 'webhook' ? crypto.randomUUID() : undefined,
    cwd: '',
    isolation: 'worktree',
    catchUp: true,
    maxRunsPerDay: 10,
    enabled: true,
  }
}

function nextRunPreview(schedule: string): string {
  try {
    const next = new Cron(schedule).nextRun()
    return next ? `Next: ${next.toLocaleString()}` : 'Never matches'
  } catch {
    return 'Invalid cron expression'
  }
}

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Every day',
  weekdays: 'Every weekday (Mon–Fri)',
  hourly: 'Every hour',
  weekly: 'Weekly on…',
  custom: 'Custom (cron expression)',
}

const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]

/** Derive a Schedule from a cron string, handling undefined gracefully. */
function scheduleFromCron(cron: string | undefined): Schedule {
  if (!cron) return { frequency: 'weekdays', time: '09:00' }
  return cronToSchedule(cron)
}

export function AutomationModal({ open, trigger, onSave, onClose }: AutomationModalProps) {
  // Local draft state
  const [draft, setDraft] = useState<CwcTrigger | null>(null)
  const [schedule, setSchedule] = useState<Schedule>({ frequency: 'weekdays', time: '09:00' })
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Initialize draft from trigger (or null for new)
  useEffect(() => {
    if (!open) return
    if (trigger) {
      setDraft({ ...trigger })
      setSchedule(scheduleFromCron(trigger.schedule))
    } else {
      setDraft(null)
      setSchedule({ frequency: 'weekdays', time: '09:00' })
    }
    setShowAdvanced(false)
  }, [open, trigger])

  function patchDraft(patch: Partial<CwcTrigger>) {
    setDraft(d => d ? { ...d, ...patch } : d)
  }

  function applySchedule(next: Schedule) {
    setSchedule(next)
    patchDraft({ schedule: scheduleToCron(next) })
  }

  function handleTypeChoose(type: CwcTrigger['type']) {
    const t = newTrigger(type)
    setDraft(t)
    setSchedule(scheduleFromCron(t.schedule))
  }

  function handleSave() {
    if (!draft) return
    onSave(draft)
    onClose()
  }

  const isNew = trigger === null
  const title = isNew
    ? (draft ? (draft.type === 'cron' ? 'New schedule' : 'New webhook') : 'Add automation')
    : (draft?.type === 'cron' ? 'Edit schedule' : 'Edit webhook')

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="automation-modal">

        {/* ── Step 0: type chooser (new trigger, type not yet chosen) ── */}
        {isNew && !draft && (
          <div className="automation-modal__chooser">
            <p className="automation-modal__chooser-label">How should this workflow run automatically?</p>
            <div className="automation-modal__chooser-cards">
              <button
                type="button"
                className="automation-modal__type-card"
                onClick={() => handleTypeChoose('cron')}
              >
                <span className="automation-modal__type-icon">⏰</span>
                <span className="automation-modal__type-name">On a schedule</span>
                <span className="automation-modal__type-desc">Runs daily, weekly, or on a custom cron pattern.</span>
              </button>
              <button
                type="button"
                className="automation-modal__type-card"
                onClick={() => handleTypeChoose('webhook')}
              >
                <span className="automation-modal__type-icon">🔗</span>
                <span className="automation-modal__type-name">When something calls a URL</span>
                <span className="automation-modal__type-desc">A local webhook — any HTTP POST starts the workflow.</span>
              </button>
            </div>
          </div>
        )}

        {/* ── Editor sections (once type is known) ── */}
        {draft && (
          <>
            {/* ── Section 1: Schedule builder ── */}
            {draft.type === 'cron' && (
              <section className="automation-modal__section">
                <h3 className="automation-modal__section-title">Schedule</h3>

                <label className="automation-modal__field">
                  <span className="automation-modal__field-label">Frequency</span>
                  <select
                    className="automation-modal__select"
                    value={schedule.frequency}
                    onChange={e => applySchedule({ ...schedule, frequency: e.target.value as Frequency })}
                  >
                    {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map(f => (
                      <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                    ))}
                  </select>
                </label>

                {(schedule.frequency === 'daily' || schedule.frequency === 'weekdays' || schedule.frequency === 'weekly') && (
                  <label className="automation-modal__field">
                    <span className="automation-modal__field-label">Time</span>
                    <input
                      type="time"
                      className="automation-modal__input automation-modal__input--time"
                      value={schedule.time ?? '09:00'}
                      onChange={e => applySchedule({ ...schedule, time: e.target.value })}
                    />
                  </label>
                )}

                {schedule.frequency === 'weekly' && (
                  <label className="automation-modal__field">
                    <span className="automation-modal__field-label">Day</span>
                    <select
                      className="automation-modal__select"
                      value={schedule.weekday ?? 1}
                      onChange={e => applySchedule({ ...schedule, weekday: Number(e.target.value) })}
                    >
                      {WEEKDAY_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                )}

                {schedule.frequency === 'custom' && (
                  <label className="automation-modal__field">
                    <span className="automation-modal__field-label">
                      <Term name="cron">Cron expression</Term>
                    </span>
                    <input
                      className="automation-modal__input automation-modal__input--mono"
                      placeholder="e.g. 0 9 * * 1-5"
                      value={schedule.raw ?? draft.schedule ?? ''}
                      onChange={e => {
                        const raw = e.target.value
                        const next: Schedule = { frequency: 'custom', raw }
                        setSchedule(next)
                        patchDraft({ schedule: raw })
                      }}
                    />
                  </label>
                )}

                <div className="automation-modal__schedule-summary">
                  {draft.schedule && (
                    <>
                      <span className="automation-modal__describe">{describeCron(draft.schedule)}</span>
                      <span className="automation-modal__next-run">{nextRunPreview(draft.schedule)}</span>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ── Section 2: Webhook ── */}
            {draft.type === 'webhook' && (
              <section className="automation-modal__section">
                <h3 className="automation-modal__section-title">
                  <Term name="webhook">Webhook</Term> URL
                </h3>
                <p className="automation-modal__webhook-note">
                  Works while CWC is running on this computer. Anything that can POST to this URL starts the workflow.
                </p>
                <div className="automation-modal__webhook-url-row">
                  <code className="automation-modal__webhook-url">
                    http://localhost:3579/api/triggers/{draft.token}
                  </code>
                  <button
                    type="button"
                    className="automation-modal__btn"
                    onClick={() => navigator.clipboard.writeText(`http://localhost:3579/api/triggers/${draft.token}`)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="automation-modal__btn"
                    onClick={() => patchDraft({ token: crypto.randomUUID() })}
                  >
                    Regenerate
                  </button>
                </div>
              </section>
            )}

            {/* ── Section 3: Where it runs ── */}
            <section className="automation-modal__section">
              <h3 className="automation-modal__section-title">Where it runs</h3>

              <label className="automation-modal__field">
                <span className="automation-modal__field-label">Working directory</span>
                <FieldHint id="trigger.cwd" />
                <input
                  className="automation-modal__input"
                  value={draft.cwd}
                  onChange={e => patchDraft({ cwd: e.target.value })}
                  placeholder="/absolute/path/to/project"
                />
              </label>

              <label className="automation-modal__field">
                <span className="automation-modal__field-label">Isolation</span>
                <select
                  className="automation-modal__select"
                  value={draft.isolation}
                  onChange={e => patchDraft({ isolation: e.target.value as CwcTrigger['isolation'] })}
                >
                  <option value="worktree">Worktree — isolated branch (recommended for git repos)</option>
                  <option value="in-place">In place</option>
                </select>
              </label>
            </section>

            {/* ── Section 4: Advanced (collapsed) ── */}
            <details
              className="automation-modal__advanced"
              open={showAdvanced}
              onToggle={e => setShowAdvanced((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="automation-modal__advanced-summary">Advanced</summary>

              <div className="automation-modal__advanced-body">
                {draft.isolation === 'worktree' && (
                  <label className="automation-modal__field">
                    <span className="automation-modal__field-label">Base ref</span>
                    <input
                      className="automation-modal__input"
                      value={draft.baseRef ?? ''}
                      onChange={e => patchDraft({ baseRef: e.target.value || undefined })}
                      placeholder="HEAD (or e.g. main)"
                    />
                  </label>
                )}

                <label className="automation-modal__field">
                  <span className="automation-modal__field-label">Precondition</span>
                  <FieldHint id="trigger.precondition" />
                  <input
                    className="automation-modal__input"
                    value={draft.precondition ?? ''}
                    onChange={e => patchDraft({ precondition: e.target.value || undefined })}
                    placeholder='test -n "$(gh pr list --json number -q .)"'
                  />
                  <span className="automation-modal__field-hint">Shell command — non-zero exit skips the run.</span>
                </label>

                <label className="automation-modal__field">
                  <span className="automation-modal__field-label">Setup command</span>
                  <FieldHint id="trigger.setupCommand" />
                  <input
                    className="automation-modal__input"
                    value={draft.setupCommand ?? ''}
                    onChange={e => patchDraft({ setupCommand: e.target.value || undefined })}
                    placeholder="Optional shell command run before Claude"
                  />
                </label>

                <label className="automation-modal__field">
                  <span className="automation-modal__field-label">Max runs per day</span>
                  <input
                    type="number"
                    className="automation-modal__input automation-modal__input--number"
                    min={0}
                    value={draft.maxRunsPerDay}
                    onChange={e => patchDraft({ maxRunsPerDay: Number(e.target.value) })}
                  />
                </label>

                {draft.type === 'cron' && (
                  <label className="automation-modal__inline-label">
                    <input
                      type="checkbox"
                      checked={draft.catchUp}
                      onChange={e => patchDraft({ catchUp: e.target.checked })}
                    />
                    Catch up if missed (e.g. laptop was asleep)
                  </label>
                )}
              </div>
            </details>

            {/* ── Footer actions ── */}
            <div className="automation-modal__footer">
              <button type="button" className="automation-modal__btn automation-modal__btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="automation-modal__btn automation-modal__btn--primary" onClick={handleSave}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
