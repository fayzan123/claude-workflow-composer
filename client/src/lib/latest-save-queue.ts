export interface LatestSaveQueue<T> {
  enqueue(key: string, value: T): Promise<void>
  isBusy(): boolean
}

interface QueuedSave<T> {
  key: string
  sequence: number
  value: T
}

interface SaveWaiter {
  sequence: number
  resolve(): void
  reject(error: unknown): void
}

/**
 * Runs at most one save at a time and retains only the newest save that has not
 * started. Callers whose pending snapshot is superseded settle with the newer
 * save, since that is the state they ultimately needed persisted.
 */
export function createLatestSaveQueue<T>(
  save: (value: T) => Promise<void>,
  onBusyChange: (busy: boolean) => void = () => {},
): LatestSaveQueue<T> {
  let sequence = 0
  let running = false
  let active: QueuedSave<T> | null = null
  let pending: QueuedSave<T> | null = null
  let waiters: SaveWaiter[] = []

  function settleThrough(completedSequence: number, result: { ok: true } | { ok: false; error: unknown }) {
    const settled = waiters.filter(waiter => waiter.sequence <= completedSequence)
    waiters = waiters.filter(waiter => waiter.sequence > completedSequence)
    for (const waiter of settled) {
      if (result.ok) waiter.resolve()
      else waiter.reject(result.error)
    }
  }

  async function pump() {
    try {
      while (pending) {
        const job = pending
        pending = null
        active = job
        try {
          await save(job.value)
          settleThrough(job.sequence, { ok: true })
        } catch (error) {
          settleThrough(job.sequence, { ok: false, error })
        } finally {
          active = null
        }
      }
    } finally {
      running = false
      onBusyChange(false)
      // No asynchronous work can interleave between the loop's final check and
      // this block, but a busy listener is user code and may enqueue a save.
      if (pending) startPump()
    }
  }

  function startPump() {
    if (running) return
    running = true
    onBusyChange(true)
    void pump()
  }

  return {
    enqueue(key, value) {
      let targetSequence: number
      if (pending?.key === key) {
        targetSequence = pending.sequence
      } else if (!pending && active?.key === key) {
        targetSequence = active.sequence
      } else {
        targetSequence = ++sequence
        pending = { key, sequence: targetSequence, value }
      }

      const settled = new Promise<void>((resolve, reject) => {
        waiters.push({ sequence: targetSequence, resolve, reject })
      })
      startPump()
      return settled
    },
    isBusy: () => running,
  }
}
