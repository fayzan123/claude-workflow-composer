import { useState, type ReactNode } from 'react'
import { getTerm } from '../../lib/help-copy.ts'
import './Term.css'

/** Wraps a jargon word with a dotted underline; click toggles a definition
 *  popover. If the term is unknown, renders the children unchanged. */
export function Term({ name, children }: { name: string; children: ReactNode }) {
  const def = getTerm(name)
  const [open, setOpen] = useState(false)
  if (!def) return <>{children}</>
  return (
    <span className="term">
      <button
        type="button"
        className="term__trigger"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <span className="term__pop" role="tooltip" onClick={() => setOpen(false)}>
          {def}
        </span>
      )}
    </span>
  )
}
