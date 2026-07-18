export type AutomationActivityKind = 'scan' | 'promotion' | 'rule'

export interface AutomationActivity {
  activeKind(): AutomationActivityKind | null
  tryAcquire(kind: AutomationActivityKind): (() => void) | null
}

/**
 * Process-local lease shared by the scan and rule routers. The lease is acquired
 * synchronously before either route reaches its first await, closing the gap where
 * a scan/promotion and a guidance-file mutation could otherwise start together.
 */
export function createAutomationActivity(): AutomationActivity {
  let active: { kind: AutomationActivityKind; token: symbol } | null = null

  return {
    activeKind: () => active?.kind ?? null,
    tryAcquire(kind) {
      if (active) return null
      const token = Symbol(kind)
      active = { kind, token }
      let released = false
      return () => {
        if (released) return
        released = true
        if (active?.token === token) active = null
      }
    },
  }
}
