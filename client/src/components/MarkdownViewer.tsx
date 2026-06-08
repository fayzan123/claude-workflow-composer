import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import './MarkdownViewer.css'

interface Props {
  filePath?: string
  content?: string
  title: string
  onClose: () => void
  onSaved?: () => void
  editNote?: string
}

export function MarkdownViewer({ filePath, content: rawContent, title, onClose, onSaved, editNote }: Props) {
  const [content, setContent] = useState<string | null>(rawContent ?? null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (rawContent !== undefined) { setContent(rawContent); return }
    if (!filePath) return
    api.fileContent(filePath)
      .then((r) => setContent(r.content))
      .catch(() => setError('Could not load file content.'))
  }, [filePath, rawContent])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current && !editing) onClose()
  }

  async function handleOpen() {
    if (!filePath) return
    try {
      await api.openFile(filePath)
    } catch {
      // silently ignore — file may open fine even if response fails
    }
  }

  function startEdit() {
    setDraft(content ?? '')
    setEditing(true)
  }

  async function handleSave() {
    if (!filePath || saving || draft.trim() === '') return
    setSaving(true)
    setError(null)
    try {
      await api.saveFileContent(filePath, draft)
      setContent(draft)
      setEditing(false)
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const canEdit = Boolean(filePath)

  return createPortal(
    <div className="markdown-viewer-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="markdown-viewer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="markdown-viewer__header">
          <span className="markdown-viewer__title">{title}</span>
          <div className="markdown-viewer__actions">
            {canEdit && !editing && (
              <button className="markdown-viewer__open-btn" onClick={startEdit}>Edit</button>
            )}
            {editing && (
              <>
                <button className="markdown-viewer__open-btn" onClick={handleSave} disabled={saving || draft.trim() === ''}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className="markdown-viewer__open-btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              </>
            )}
            {canEdit && !editing && (
              <button className="markdown-viewer__open-btn" onClick={handleOpen}>Open in editor</button>
            )}
            <button className="markdown-viewer__close-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="markdown-viewer__body">
          {!content && !error && !editing && <div className="markdown-viewer__loading">Loading…</div>}
          {error && <div className="markdown-viewer__error">{error}</div>}
          {editing ? (
            <>
              {editNote && <div className="markdown-viewer__editnote">{editNote}</div>}
              <textarea
                className="markdown-viewer__editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </>
          ) : (
            content && <pre className="markdown-viewer__pre">{content}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
