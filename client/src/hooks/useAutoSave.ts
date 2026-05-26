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
): { isSaving: boolean; isDirty: boolean; flush: () => Promise<void> } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')
  const onErrorRef = useRef(options?.onError)
  const onSuccessRef = useRef(options?.onSuccess)
  const workflowRef = useRef(workflow)
  const filePathRef = useRef(filePath)

  const [isSaving, setIsSaving] = useState(false)
  const [hasPendingTimer, setHasPendingTimer] = useState(false)

  // Keep refs in sync with latest values (avoids stale closures in flush/callbacks)
  useEffect(() => {
    onErrorRef.current = options?.onError
    onSuccessRef.current = options?.onSuccess
    workflowRef.current = workflow
    filePathRef.current = filePath
  })

  const runSave = useCallback(async () => {
    const fp = filePathRef.current
    const wf = workflowRef.current
    if (!fp) return
    setIsSaving(true)
    let succeeded = false
    try {
      await api.workflows.save(fp, wf)
      succeeded = true
    } catch (err) {
      onErrorRef.current?.(err as Error)
      throw err
    } finally {
      setIsSaving(false)
      setHasPendingTimer(false)
    }
    if (succeeded) onSuccessRef.current?.()
  }, []) // stable — reads everything via refs

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await runSave()
  }, [runSave])

  useEffect(() => {
    if (!filePath) return
    const serialized = JSON.stringify(workflow)
    if (serialized === prevRef.current) return
    prevRef.current = serialized

    // Cancel any existing pending timer (don't clear dirty state — will be cleared in finally)
    if (timerRef.current) clearTimeout(timerRef.current)

    setHasPendingTimer(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runSave().catch(() => {}) // error already surfaced via onError
    }, 500)

    // Cleanup: cancel timer only. Do NOT reset isSaving or hasPendingTimer here —
    // this cleanup runs on every keystroke and would cause dirty state to flicker.
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [workflow, filePath, runSave])

  return { isSaving, isDirty: hasPendingTimer || isSaving, flush }
}
