import { useEffect, useRef } from 'react'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'

export function useAutoSave(workflow: CwcFile, filePath: string | null, onError?: (err: Error) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')

  useEffect(() => {
    if (!filePath) return
    const serialized = JSON.stringify(workflow)
    if (serialized === prevRef.current) return
    prevRef.current = serialized

    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        await api.workflows.save(filePath, workflow)
      } catch (err) {
        onError?.(err as Error)
      }
    }, 500)

    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [workflow, filePath, onError])
}
