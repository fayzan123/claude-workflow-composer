import React, { useEffect, useRef, useId } from 'react'
import { createPortal } from 'react-dom'
import './Drawer.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}

/** All focusable elements inside a container, ordered by DOM position. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  )
}

export function Drawer({ open, onClose, title, children }: DrawerProps) {
  const titleId = useId()
  const drawerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<Element | null>(null)

  // Save previously focused element on open, restore on close
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement
      // Move focus into the drawer on next frame
      requestAnimationFrame(() => {
        if (drawerRef.current) {
          const focusable = getFocusable(drawerRef.current)
          if (focusable.length > 0) {
            focusable[0].focus()
          } else {
            drawerRef.current.focus()
          }
        }
      })
    } else {
      const prev = previousFocusRef.current
      if (prev && prev instanceof HTMLElement) {
        prev.focus()
      }
      previousFocusRef.current = null
    }
  }, [open])

  // Esc key + Tab focus trap
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }

      // Focus trap: keep Tab cycling within the drawer
      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = getFocusable(drawerRef.current)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="drawer-root" aria-hidden={!open}>
      {/* Scrim */}
      <div
        className="drawer-scrim"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={drawerRef}
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {title && (
          <div className="drawer-header">
            <h2 id={titleId} className="drawer-title">{title}</h2>
            <button
              type="button"
              className="drawer-close"
              onClick={onClose}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
        <div className="drawer-body">
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}
