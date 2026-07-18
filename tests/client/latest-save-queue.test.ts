import { describe, expect, it } from 'vitest'
import { createLatestSaveQueue } from '../../client/src/lib/latest-save-queue.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('latest save queue', () => {
  it('serializes saves and persists the newest pending snapshot last', async () => {
    const firstSave = deferred()
    const started: string[] = []
    const completed: string[] = []
    let active = 0
    let maxActive = 0
    const queue = createLatestSaveQueue(async (value: string) => {
      started.push(value)
      active++
      maxActive = Math.max(maxActive, active)
      if (value === 'before-export') await firstSave.promise
      completed.push(value)
      active--
    })

    const beforeExport = queue.enqueue('before-export', 'before-export')
    const intermediate = queue.enqueue('intermediate', 'intermediate')
    const withExportMetadata = queue.enqueue('with-export-metadata', 'with-export-metadata')

    expect(started).toEqual(['before-export'])
    expect(queue.isBusy()).toBe(true)
    firstSave.resolve()
    await Promise.all([beforeExport, intermediate, withExportMetadata])

    expect(maxActive).toBe(1)
    expect(started).toEqual(['before-export', 'with-export-metadata'])
    expect(completed).toEqual(['before-export', 'with-export-metadata'])
    expect(queue.isBusy()).toBe(false)
  })

  it('deduplicates a flush for the snapshot already being saved', async () => {
    const save = deferred()
    let calls = 0
    const queue = createLatestSaveQueue(async () => {
      calls++
      await save.promise
    })

    const autosave = queue.enqueue('same-path-and-content', 'snapshot')
    const flush = queue.enqueue('same-path-and-content', 'snapshot')
    expect(calls).toBe(1)

    save.resolve()
    await Promise.all([autosave, flush])
    expect(calls).toBe(1)
  })

  it('continues with a newer snapshot after an earlier save fails', async () => {
    const failure = new Error('first save failed')
    const saved: string[] = []
    const queue = createLatestSaveQueue(async (value: string) => {
      if (value === 'old') throw failure
      saved.push(value)
    })

    const old = queue.enqueue('old', 'old')
    const latest = queue.enqueue('latest', 'latest')

    await expect(old).rejects.toBe(failure)
    await expect(latest).resolves.toBeUndefined()
    expect(saved).toEqual(['latest'])
  })
})
