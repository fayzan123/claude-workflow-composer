import { getControlHint } from '../../lib/help-copy.ts'
import './FieldHint.css'

/** A quiet, one-line description rendered under a control's label.
 *  Renders nothing if the id has no glossary entry. */
export function FieldHint({ id }: { id: string }) {
  const text = getControlHint(id)
  if (!text) return null
  return <span className="field-hint">{text}</span>
}
