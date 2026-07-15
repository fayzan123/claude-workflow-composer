import { useEffect, useState } from 'react'
import { subscribeToasts, dismissToast, type Toast } from '../lib/toast.ts'
import './Toaster.css'

/** App-level notification stack. Mount once, above the router. */
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => subscribeToasts(setToasts), [])
  if (toasts.length === 0) return null
  return (
    <div className="toaster" role="region" aria-label="Notifications">
      {toasts.map(t => <ToastCard key={t.id} toast={t} />)}
    </div>
  )
}

const ICON: Record<Toast['tone'], string> = { success: '✓', error: '!', info: 'i' }

function ToastCard({ toast }: { toast: Toast }) {
  useEffect(() => {
    if (!toast.duration) return
    const id = setTimeout(() => dismissToast(toast.id), toast.duration)
    return () => clearTimeout(id)
  }, [toast.id, toast.duration])
  return (
    <div className={`toast toast--${toast.tone}`} role="status" aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}>
      <span className="toast__icon" aria-hidden="true">{ICON[toast.tone]}</span>
      <div className="toast__body">
        <p className="toast__title">{toast.title}</p>
        {toast.detail && <p className="toast__detail">{toast.detail}</p>}
      </div>
      {toast.action && (
        <button
          className="toast__action"
          type="button"
          onClick={() => { dismissToast(toast.id); toast.action?.onClick() }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast__close" type="button" aria-label="Dismiss notification" onClick={() => dismissToast(toast.id)}>×</button>
    </div>
  )
}
