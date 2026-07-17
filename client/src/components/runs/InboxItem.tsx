import React, { useState, useEffect } from 'react'
import type { RunEvent } from '../../../../src/run-events.ts'
import type { RunSummary } from '../../../../src/server/run-store.ts'
import { api } from '../../lib/api.ts'
import { fmtRelative } from './format.ts'

export interface InboxItemProps {
  run: RunSummary
  onChanged: () => void
}

export function InboxItem({ run, onChanged }: InboxItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents] = useState<RunEvent[] | null>(null)
  const [eventsLoadError, setEventsLoadError] = useState<string | null>(null)
  const [diffResult, setDiffResult] = useState<{ diff: string | null; status: string | null; branch: string | null } | null>(null)
  const [note, setNote] = useState('')
  const [actError, setActError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)

  function expand() {
    setExpanded(e => !e)
  }

  // Refetch events + diff whenever the card is open AND whenever the run gets a
  // new event (lastEventAt changes). A one-shot fetch on expand races the
  // run_paused event — if the card opens between awaiting_approval and run_paused,
  // it would cache "no resumable session" forever and wrongly disable Approve.
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setEvents(null)
    setEventsLoadError(null)
    setDiffResult(null)
    void api.runs.events(run.workflowId, run.runId).then((evs) => {
      if (cancelled) return
      setEvents(evs)
      setEventsLoadError(null)
    }).catch((err) => {
      if (cancelled) return
      setEvents(null)
      setEventsLoadError(err instanceof Error ? err.message : 'Failed to load run events')
    })
    void api.runs.diff(run.workflowId, run.runId).catch(() => ({ diff: null, status: null, branch: null })).then((diff) => {
      if (cancelled) return
      setDiffResult(diff)
    })
    return () => { cancelled = true }
  }, [expanded, run.workflowId, run.runId, run.lastEventAt])

  const hasPausedEvent = events?.some(e => e.type === 'run_paused') ?? false
  const approvalMsg = events?.findLast?.(e => e.type === 'awaiting_approval' || e.type === 'run_paused')?.message

  // On success we deliberately leave `acting` true: the card stays disabled (showing
  // "Approving…") until the run leaves the paused list and this item unmounts. Only
  // re-enable on error so the user can retry. This stops the "it wasn't instant so I
  // kept clicking" double-fire.
  async function doApprove() {
    setActError(null)
    setActing(true)
    try {
      await api.runs.approve(run.workflowId, run.runId, note || undefined)
      onChanged()
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Failed to approve')
      setActing(false)
    }
  }

  async function doReject() {
    setActError(null)
    setActing(true)
    try {
      await api.runs.reject(run.workflowId, run.runId, note || undefined)
      onChanged()
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Failed to reject')
      setActing(false)
    }
  }

  // The server's manifest authority (run.actions.approve) is the final word: a paused
  // run without a resumable session binding always 409s, so never offer a dead-end button.
  const approveDisabled = (events !== null && !hasPausedEvent) || !run.actions.approve
  const approveTooltip = approveDisabled
    ? (run.managed
      ? "This paused run can't be resumed from CWC because it has no resumable session binding — reject it and start a new run."
      : "This run was started from a terminal, so CWC can't resume it here — continue it where you launched it, or reject to clean up.")
    : undefined

  return (
    <div className="run-panel__inbox-item">
      <button type="button" className="run-panel__inbox-header" onClick={expand}>
        <span className="run-panel__inbox-slug">{run.workflowSlug ?? run.workflowId}</span>
        <span className="run-panel__inbox-when">{fmtRelative(run.lastEventAt ?? run.startedAt)}</span>
        {diffResult?.branch && <span className="run-panel__inbox-branch">{diffResult.branch}</span>}
        <span className="run-panel__inbox-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="run-panel__inbox-body">
          {approvalMsg && (
            <p className="run-panel__inbox-msg">{approvalMsg}</p>
          )}

          {diffResult === null ? (
            <p className="run-panel__inbox-loading">Loading diff…</p>
          ) : diffResult.diff === null ? (
            <p className="run-panel__inbox-no-git">No git repo here, so there's no diff to preview — review the agent's work directly, then approve or reject below.</p>
          ) : (
            <>
              <pre className="run-panel__diff">{diffResult.diff}</pre>
              {diffResult.status && (
                <div className="run-panel__diff-status">
                  <strong>Status:</strong>
                  <pre className="run-panel__diff">{diffResult.status}</pre>
                </div>
              )}
            </>
          )}

          <textarea
            className="run-panel__inbox-note"
            placeholder="Optional note for the agent…"
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
          />

          {actError && <p className="run-panel__inbox-error">{actError}</p>}
          {eventsLoadError && <p className="run-panel__inbox-error">Could not load run events: {eventsLoadError}</p>}
          {approveDisabled && (
            <p className="run-panel__inbox-hint">{approveTooltip}</p>
          )}

          <div className="run-panel__inbox-actions">
            <button
              type="button"
              className="run-panel__inbox-approve"
              onClick={doApprove}
              disabled={acting || approveDisabled}
              title={approveTooltip}
            >
              {acting ? 'Approving...' : 'Approve'}
            </button>
            <button
              type="button"
              className="run-panel__inbox-reject"
              onClick={doReject}
              disabled={acting}
            >
              {acting ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
