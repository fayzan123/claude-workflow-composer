export interface ScanWatcherAutomation {
  status: string
}

export interface ScanWatcherSnapshot {
  status: string
  startedAt?: string
  error?: string
  automations: ScanWatcherAutomation[]
}

export interface ScanCompletionNotification {
  tone: 'success' | 'error'
  title: string
  detail: string
}

/**
 * Report only terminal transitions observed after the shell has initialized.
 * A changed startedAt also catches a short scan that starts and finishes between polls.
 */
export function scanCompletionNotification(
  previous: ScanWatcherSnapshot | null,
  current: ScanWatcherSnapshot,
): ScanCompletionNotification | null {
  if (!previous || (current.status !== 'done' && current.status !== 'error')) return null

  const sameScan = Boolean(current.startedAt)
    && current.startedAt === previous.startedAt
  const completedObservedScan = sameScan && previous.status === 'running'
  const completedBetweenPolls = Boolean(current.startedAt)
    && current.startedAt !== previous.startedAt

  if (!completedObservedScan && !completedBetweenPolls) return null

  if (current.status === 'error') {
    return {
      tone: 'error',
      title: 'History scan failed',
      detail: current.error || 'Review the scan log for details.',
    }
  }

  const count = current.automations.filter(automation => automation.status !== 'dismissed').length
  return {
    tone: 'success',
    title: 'History scan complete',
    detail: count > 0
      ? `${count} automation${count === 1 ? '' : 's'} found`
      : 'No strong patterns found this time',
  }
}
