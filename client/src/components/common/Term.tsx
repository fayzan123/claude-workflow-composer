import { useState, useId, type ReactNode } from 'react'
import { getTerm } from '../../lib/help-copy.ts'
import './Term.css'

/** Wraps a jargon word with a dotted underline; click/Enter/Space toggles a
 *  definition popover. Renders children unchanged if the term is unknown.
 *  Uses a span (not a button) so it can be safely nested inside other buttons
 *  and labels. */
export function Term({ name, children }: { name: string; children: ReactNode }) {
  const def = getTerm(name)
  const [open, setOpen] = useState(false)
  const popId = useId()
  if (!def) return <>{children}</>
  return (
    <span className="term">
      <span
        role="button"
        tabIndex={0}
        className="term__trigger"
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o) }
          else if (e.key === 'Escape') { setOpen(false) }
        }}
      >
        {children}
      </span>
      {open && (
        <span id={popId} className="term__pop" role="status" onClick={() => setOpen(false)}>
          {def}
        </span>
      )}
    </span>
  )
}
