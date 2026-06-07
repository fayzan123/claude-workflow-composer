import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import './MarkdownViewer.css'

interface Props {
  filePath?: string
  content?: string
  title: string
  onClose: () => void
}

export function MarkdownViewer({ filePath, content: rawContent, title, onClose }: Props) {
  const [content, setContent] = useState<string | null>(rawContent ?? null)
  const [error, setError] = useState<string | null>(null)
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
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  async function handleOpen() {
    if (!filePath) return
    try {
      await api.openFile(filePath)
    } catch {
      // silently ignore — file may open fine even if response fails
    }
  }

  return createPortal(
    <div className="markdown-viewer-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="markdown-viewer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="markdown-viewer__header">
          <span className="markdown-viewer__title">{title}</span>
          <div className="markdown-viewer__actions">
            {filePath && (
              <button className="markdown-viewer__open-btn" onClick={handleOpen}>
                Open in editor
              </button>
            )}
            <button className="markdown-viewer__close-btn" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="markdown-viewer__body">
          {!content && !error && <div className="markdown-viewer__loading">Loading…</div>}
          {error && <div className="markdown-viewer__error">{error}</div>}
          {content && <pre className="markdown-viewer__pre">{content}</pre>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
