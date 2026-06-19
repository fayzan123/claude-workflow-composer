import { useCallback, useEffect, useMemo, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'cwc.theme'
const THEME_CHANGE_EVENT = 'cwc-theme-change'

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null
}

export function resolveThemePreference(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === 'system' ? systemTheme : preference
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)) ?? 'system'
  } catch {
    return 'system'
  }
}

function activeTheme(): { preference: ThemePreference; resolvedTheme: ResolvedTheme } {
  const preference = storedPreference()
  const attrTheme = typeof document !== 'undefined' ? parseThemePreference(document.documentElement.dataset.theme) : null
  return {
    preference,
    resolvedTheme: attrTheme === 'light' || attrTheme === 'dark'
      ? attrTheme
      : resolveThemePreference(preference, systemTheme()),
  }
}

export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolvedTheme = resolveThemePreference(preference, systemTheme())
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.dataset.themePreference = preference
    document.documentElement.style.colorScheme = resolvedTheme
  }
  return resolvedTheme
}

function saveThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* localStorage may be disabled; document theme still updates. */
  }
}

function emitThemeChange(preference: ThemePreference, resolvedTheme: ResolvedTheme): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { preference, resolvedTheme } }))
}

export function useThemePreference() {
  const [state, setState] = useState(activeTheme)

  useEffect(() => {
    const resolvedTheme = applyThemePreference(state.preference)
    if (resolvedTheme !== state.resolvedTheme) setState(s => ({ ...s, resolvedTheme }))
  }, [state.preference, state.resolvedTheme])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      setState(current => {
        if (current.preference !== 'system') return current
        return { ...current, resolvedTheme: applyThemePreference('system') }
      })
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onThemeChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<{ preference: ThemePreference; resolvedTheme: ResolvedTheme }>>).detail
      const preference = parseThemePreference(detail?.preference) ?? storedPreference()
      const resolvedTheme = detail?.resolvedTheme === 'light' || detail?.resolvedTheme === 'dark'
        ? detail.resolvedTheme
        : resolveThemePreference(preference, systemTheme())
      setState({ preference, resolvedTheme })
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return
      const preference = parseThemePreference(event.newValue) ?? 'system'
      setState({ preference, resolvedTheme: applyThemePreference(preference) })
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setPreference = useCallback((preference: ThemePreference) => {
    saveThemePreference(preference)
    const resolvedTheme = applyThemePreference(preference)
    emitThemeChange(preference, resolvedTheme)
    setState({ preference, resolvedTheme })
  }, [])

  const toggleTheme = useCallback(() => {
    setState(current => {
      const nextPreference: ThemePreference = current.resolvedTheme === 'dark' ? 'light' : 'dark'
      saveThemePreference(nextPreference)
      const resolvedTheme = applyThemePreference(nextPreference)
      emitThemeChange(nextPreference, resolvedTheme)
      return { preference: nextPreference, resolvedTheme }
    })
  }, [])

  return useMemo(() => ({ ...state, setPreference, toggleTheme }), [state, setPreference, toggleTheme])
}
