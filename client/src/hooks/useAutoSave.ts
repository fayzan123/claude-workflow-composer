import { useCallback, useEffect, useRef, useState } from 'react'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'

interface UseAutoSaveOptions {
  onError?: (err: Error) => void
  onSuccess?: () => void
}

export function useAutoSave(
  workflow: CwcFile,
  filePath: string | null,
  options?: UseAutoSaveOptions,
): { isSaving: boolean; isDirty: boolean; flush: () => Promise<void>; suspend: () => void; resume: (nextFilePath?: string | null) => void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')
  const onErrorRef = useRef(options?.onError)
  const onSuccessRef = useRef(options?.onSuccess)
  const workflowRef = useRef(workflow)
  const filePathRef = useRef(filePath)
  const suspendedRef = useRef(false)

  const [isSaving, setIsSaving] = useState(false)
  const [hasPendingTimer, setHasPendingTimer] = useState(false)
  const [hasFailedSave, setHasFailedSave] = useState(false)

  // Keep refs in sync with latest values (avoids stale closures in flush/callbacks)
  useEffect(() => {
    onErrorRef.current = options?.onError
    onSuccessRef.current = options?.onSuccess
    workflowRef.current = workflow
    filePathRef.current = filePath
  })

  const runSave = useCallback(async (force = false) => {
    const fp = filePathRef.current
    const wf = workflowRef.current
    if (!fp || (!force && suspendedRef.current)) return
    const serialized = JSON.stringify(wf)
    setIsSaving(true)
    try {
      await api.workflows.save(fp, wf)
      prevRef.current = serialized
      setHasFailedSave(false)
      onSuccessRef.current?.()
    } catch (err) {
      setHasFailedSave(true)
      onErrorRef.current?.(err as Error)
      throw err
    } finally {
      setIsSaving(false)
      setHasPendingTimer(false)
    }
  }, []) // stable — reads everything via refs

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setHasPendingTimer(false)
    await runSave(true)
  }, [runSave])

  const queueSave = useCallback(() => {
    if (suspendedRef.current || !filePathRef.current) return
    const serialized = JSON.stringify(workflowRef.current)
    if (serialized === prevRef.current) {
      setHasFailedSave(false)
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)

    setHasPendingTimer(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runSave().catch(() => {}) // error already surfaced via onError
    }, 500)
  }, [runSave])

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
  }, [workflow, filePath, queueSave])

  return { isSaving, isDirty: hasPendingTimer || isSaving || hasFailedSave, flush, suspend, resume }
}
