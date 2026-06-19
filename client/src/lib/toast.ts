// Minimal app-level toast store. Lives outside React so a toast fired right before a
// route change (e.g. promote → navigate to the new workflow) survives the navigation:
// the <Toaster/> is mounted once at the app root, above <Routes>.

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  detail?: string
  /** ms before auto-dismiss; 0 = sticky until dismissed. */
  duration: number
}

type Listener = (toasts: Toast[]) => void

let toasts: Toast[] = []
const listeners = new Set<Listener>()

function emit() { for (const l of listeners) l(toasts) }

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(toasts)
  return () => { listeners.delete(l) }
}

export function dismissToast(id: string): void {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

function push(tone: ToastTone, title: string, detail?: string, duration = 5000): string {
  const id = Math.random().toString(36).slice(2)
  toasts = [...toasts, { id, tone, title, detail, duration }]
  emit()
  return id
}

export const toast = {
  success: (title: string, detail?: string) => push('success', title, detail, 6000),
  error: (title: string, detail?: string) => push('error', title, detail, 9000),
  info: (title: string, detail?: string) => push('info', title, detail, 6000),
}
