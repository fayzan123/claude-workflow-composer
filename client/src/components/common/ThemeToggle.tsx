import React from 'react'
import { useThemePreference } from '../../lib/theme.ts'
import './ThemeToggle.css'

function SunIcon() {
  return (
    <svg className="theme-toggle__icon theme-toggle__icon--sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg className="theme-toggle__icon theme-toggle__icon--moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.6 14.8A8.5 8.5 0 0 1 9.2 3.4 8.5 8.5 0 1 0 20.6 14.8Z" />
    </svg>
  )
}

interface Props {
  className?: string
}

export function ThemeToggle({ className = '' }: Props) {
  const { resolvedTheme, toggleTheme } = useThemePreference()
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${nextTheme} mode`

  return (
    <button
      className={`theme-toggle ${className}`.trim()}
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      data-theme-state={resolvedTheme}
    >
      {resolvedTheme === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  )
}
