import { useCallback, useEffect, useRef, useState } from 'react'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'
import { createLatestSaveQueue, type LatestSaveQueue } from '../lib/latest-save-queue.ts'

interface UseAutoSaveOptions {
  revision?: string | null
  onError?: (err: Error) => void
  onSuccess?: () => void
  onRevision?: (revision: string) => void
}

interface SaveSnapshot {
  filePath: string
  serialized: string
  workflow: CwcFile
}

interface AutoSaveController {
  isSaving: boolean
  isDirty: boolean
  flush: () => Promise<string>
  acknowledge: (workflow: CwcFile, revision: string, nextFilePath?: string | null) => void
  suspend: () => void
  resume: (nextFilePath?: string | null) => void
}

export function useAutoSave(
  workflow: CwcFile,
  filePath: string | null,
  options?: UseAutoSaveOptions,
): AutoSaveController {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')
  const onErrorRef = useRef(options?.onError)
  const onSuccessRef = useRef(options?.onSuccess)
  const onRevisionRef = useRef(options?.onRevision)
  const revisionRef = useRef<string | null>(options?.revision ?? null)
  const trackedFilePathRef = useRef<string | null>(null)
  const workflowRef = useRef(workflow)
  const filePathRef = useRef(filePath)
  const suspendedRef = useRef(false)
  const mountedRef = useRef(true)
  const saveQueueRef = useRef<LatestSaveQueue<SaveSnapshot> | null>(null)

  const [isSaving, setIsSaving] = useState(false)
  const [hasPendingTimer, setHasPendingTimer] = useState(false)
  const [hasFailedSave, setHasFailedSave] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Keep refs in sync with latest values (avoids stale closures in flush/callbacks)
  useEffect(() => {
    onErrorRef.current = options?.onError
    onSuccessRef.current = options?.onSuccess
    onRevisionRef.current = options?.onRevision
    revisionRef.current = options?.revision ?? null
    workflowRef.current = workflow
    filePathRef.current = filePath
  })

  // A newly loaded or renamed path starts from an acknowledged server snapshot.
  // Do this before the queueing effect below so opening a recipe is not itself a save.
  useEffect(() => {
    if (!filePath || !options?.revision || trackedFilePathRef.current === filePath) return
    trackedFilePathRef.current = filePath
    revisionRef.current = options.revision
    prevRef.current = JSON.stringify(workflow)
    setHasFailedSave(false)
  }, [filePath, options?.revision, workflow])

  const getSaveQueue = useCallback(() => {
    if (!saveQueueRef.current) {
      saveQueueRef.current = createLatestSaveQueue(async (snapshot) => {
        try {
          const expectedRevision = revisionRef.current
          if (!expectedRevision) throw new Error('Workflow revision is unavailable. Reload this recipe before saving.')
          const saved = await api.workflows.save(snapshot.filePath, snapshot.workflow, expectedRevision)
          revisionRef.current = saved.revision
          onRevisionRef.current?.(saved.revision)
          prevRef.current = snapshot.serialized
          if (mountedRef.current) {
            setHasFailedSave(false)
            onSuccessRef.current?.()
          }
        } catch (err) {
          if (mountedRef.current) {
            setHasFailedSave(true)
            onErrorRef.current?.(err as Error)
          }
          throw err
        }
      }, (busy) => {
        if (mountedRef.current) setIsSaving(busy)
      })
    }
    return saveQueueRef.current
  }, [])

  const enqueueCurrentSave = useCallback((force = false): Promise<void> => {
    const fp = filePathRef.current
    const wf = workflowRef.current
    if (!fp || !revisionRef.current || (!force && suspendedRef.current)) return Promise.resolve()
    const serialized = JSON.stringify(wf)
    // A matching previous snapshot is clean only while no older write is in
    // flight. If the user edits and then reverts during that request, enqueue
    // the reverted snapshot so the older request cannot become the final state.
    if (!force && serialized === prevRef.current && !saveQueueRef.current?.isBusy()) {
      if (mountedRef.current) {
        setHasFailedSave(false)
      }
      return Promise.resolve()
    }

    // Preserve the exact state associated with this queue entry. Reducer state
    // is immutable today, but the serialized round trip prevents a future
    // mutable caller from changing an in-flight request by reference.
    const snapshot: SaveSnapshot = {
      filePath: fp,
      serialized,
      workflow: JSON.parse(serialized) as CwcFile,
    }
    return getSaveQueue().enqueue(`${fp}\u0000${serialized}`, snapshot)
  }, [getSaveQueue])

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setHasPendingTimer(false)
    if (!filePathRef.current || !revisionRef.current) {
      throw new Error('Workflow revision is unavailable. Reload this recipe before continuing.')
    }
    await enqueueCurrentSave(true)
    if (!revisionRef.current) {
      throw new Error('Workflow revision is unavailable. Reload this recipe before continuing.')
    }
    return revisionRef.current
  }, [enqueueCurrentSave])

  // Export/delete/rename can commit a recipe snapshot on the server while
  // holding the shared mutation lease. Acknowledge those exact bytes before
  // dispatching the matching reducer update so autosave does not immediately
  // rewrite them or race another editor with a redundant request.
  const acknowledge = useCallback((acknowledgedWorkflow: CwcFile, revision: string, nextFilePath?: string | null) => {
    if (!/^[0-9a-f]{64}$/.test(revision)) {
      throw new Error('Server returned an invalid workflow revision.')
    }
    revisionRef.current = revision
    prevRef.current = JSON.stringify(acknowledgedWorkflow)
    workflowRef.current = acknowledgedWorkflow
    if (nextFilePath !== undefined) {
      filePathRef.current = nextFilePath
      trackedFilePathRef.current = nextFilePath
    }
    setHasFailedSave(false)
    onRevisionRef.current?.(revision)
  }, [])

  const queueSave = useCallback(() => {
    if (suspendedRef.current || !filePathRef.current) return
    const serialized = JSON.stringify(workflowRef.current)
    if (serialized === prevRef.current && !saveQueueRef.current?.isBusy()) {
      setHasFailedSave(false)
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)

    setHasPendingTimer(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setHasPendingTimer(false)
      enqueueCurrentSave().catch(() => {}) // error already surfaced via onError
    }, 500)
  }, [enqueueCurrentSave])

  const suspend = useCallback(() => {
    suspendedRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setHasPendingTimer(false)
  }, [])

  const resume = useCallback((nextFilePath?: string | null) => {
    if (nextFilePath !== undefined) filePathRef.current = nextFilePath
    suspendedRef.current = false
    queueSave()
  }, [queueSave])

  useEffect(() => {
    if (!filePath) return
    queueSave()

    // Cleanup: cancel timer only. Do NOT reset isSaving or hasPendingTimer here —
    // this cleanup runs on every keystroke and would cause dirty state to flicker.
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [workflow, filePath, options?.revision, queueSave])

  return { isSaving, isDirty: hasPendingTimer || isSaving || hasFailedSave, flush, acknowledge, suspend, resume }
}
