import { useEffect, useRef, useState } from 'react'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'

export function useAutoSave(workflow: CwcFile, filePath: string | null, onError?: (err: Error) => void): { isSaving: boolean } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')
  const onErrorRef = useRef(onError)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    onErrorRef.current = onError
  })

  useEffect(() => {
    if (!filePath) return
    const serialized = JSON.stringify(workflow)
    if (serialized === prevRef.current) return
    prevRef.current = serialized

    if (timerRef.current) clearTimeout(timerRef.current)
    setIsSaving(true)
    timerRef.current = setTimeout(async () => {
      try {
        await api.workflows.save(filePath, workflow)
      } catch (err) {
        // prevRef already advanced — failed saves are not retried; caller is notified via onError
        onErrorRef.current?.(err as Error)
      } finally {
        setIsSaving(false)
      }
    }, 500)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        setIsSaving(false)
      }
    }
  }, [workflow, filePath])  // onError NOT in deps — read via ref instead

  return { isSaving }
}
