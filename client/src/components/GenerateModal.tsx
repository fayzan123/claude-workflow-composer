import { useState, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './GenerateModal.css'

export interface GenerateAdapter<TSpec> {
  title: string                          // "Generate agent" | "Generate skill"
  noun: string                           // "agent" | "skill"
  inputPlaceholderEmpty: string          // first-turn chat placeholder
  inputPlaceholderRefine: string         // refine-turn chat placeholder
  buildingStatus: string                 // "Writing the agent…" | "Writing the skill…"
  buildButtonLabel: string               // "Build agent →" | "Build skill →"
  saveButtonLabel: string                // "Save to ~/.claude/agents/" | "Save to ~/.claude/skills/"
  savedTitle: string                     // "Agent created" | "Skill created"
  savedHint: string                      // confirmation hint line
  specName: (spec: TSpec) => string      // used for the chat note, saved name, build-disabled check
  savePathLabel: (slug: string) => string // "~/.claude/agents/<slug>.md" | "~/.claude/skills/<slug>/SKILL.md"
  renderSpecPanel: (spec: TSpec, patch: (next: Partial<TSpec>) => void) => ReactNode
  api: {
    spec: (message: string, sessionId?: string) => Promise<{ spec: TSpec; sessionId: string }>
    build: (spec: TSpec, sessionId?: string) => Promise<{ content: string; slug: string }>
    save: (slug: string, content: string, overwrite: boolean) => Promise<{ slug: string }>
  }
}

interface Props<TSpec> {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
  adapter: GenerateAdapter<TSpec>
}

type ChatMsg = { role: 'user' | 'assistant'; text: string }

export function GenerateModal<TSpec>({ open, onClose, onCreated, adapter }: Props<TSpec>) {
  const [phase, setPhase] = useState<'spec' | 'build' | 'done'>('spec')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [spec, setSpec] = useState<TSpec | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ content: string; slug: string } | null>(null)
  const [saved, setSaved] = useState<{ name: string; slug: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, status])
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function sendMessage() {
    const msg = input.trim()
    if (!msg || busy) return
    setError(null)
    setBusy(true)
    setStatus('Refining...')
    setMessages((m) => [...m, { role: 'user', text: msg }])
    setInput('')
    try {
      const { spec: newSpec, sessionId: sid } = await adapter.api.spec(msg, sessionId)
      setSpec(newSpec)
      setSessionId(sid)
      setMessages((m) => [...m, { role: 'assistant', text: `Updated spec: ${adapter.specName(newSpec)}` }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function build() {
    if (spec === null || busy) return
    setError(null)
    setBusy(true)
    setStatus(adapter.buildingStatus)
    try {
      const result = await adapter.api.build(spec, sessionId)
      setDraft(result)
      setPhase('build')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function save() {
    if (!draft || busy) return
    setError(null)
    setBusy(true)
    try {
      let result
      try {
        result = await adapter.api.save(draft.slug, draft.content, false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Save failed'
        if (/already exists/i.test(msg) && window.confirm(`${msg}\n\nOverwrite it?`)) {
          try {
            result = await adapter.api.save(draft.slug, draft.content, true)
          } catch (overwriteErr) {
            setError(overwriteErr instanceof Error ? overwriteErr.message : 'Save failed')
            return
          }
        } else {
          if (!/already exists/i.test(msg)) setError(msg)
          return
        }
      }
      onCreated(result.slug)
      setSaved({ name: spec !== null ? adapter.specName(spec) : result.slug, slug: result.slug })
      setPhase('done')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setPhase('spec'); setMessages([]); setInput(''); setSpec(null)
    setSessionId(undefined); setDraft(null); setSaved(null); setError(null)
  }

  const hasProgress = messages.length > 0 || spec !== null || draft !== null

  function startNew() {
    if (busy) return
    if (!hasProgress || window.confirm(`Start over? This clears the current ${adapter.noun}.`)) reset()
  }

  function patch(next: Partial<TSpec>) {
    setSpec((s) => (s !== null ? { ...s, ...next } : s))
  }

  if (!open) return null

  return createPortal(
    <div className="gen-agent-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gen-agent" role="dialog" aria-modal="true" aria-label={adapter.title}>
        <div className="gen-agent__header">
          <span className="gen-agent__title">{adapter.title}</span>
          <div className="gen-agent__header-actions">
            {phase !== 'done' && hasProgress && (
              <button className="gen-agent__newbtn" onClick={startNew} disabled={busy}>Start new</button>
            )}
            <button className="gen-agent__close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {error && <div className="gen-agent__error">{error}</div>}

        {phase === 'spec' && (
          <div className="gen-agent__body">
            <div className="gen-agent__chat">
              <div className="gen-agent__messages">
                {messages.length === 0 && (
                  <p className="gen-agent__hint">Describe the {adapter.noun} you want. What should it do, and when should it be used?</p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`gen-agent__msg gen-agent__msg--${m.role}`}>{m.text}</div>
                ))}
                {status && <div className="gen-agent__status">{status}</div>}
                <div ref={messagesEndRef} />
              </div>
              <div className="gen-agent__input-row">
                <textarea
                  className="gen-agent__input"
                  value={input}
                  placeholder={spec !== null ? adapter.inputPlaceholderRefine : adapter.inputPlaceholderEmpty}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMessage() }}
                />
                <button className="gen-agent__send" onClick={sendMessage} disabled={busy || !input.trim()}>
                  {spec !== null ? 'Refine' : 'Start'}
                </button>
              </div>
            </div>

            <div className="gen-agent__spec">
              {spec === null && <p className="gen-agent__hint">The proposed spec will appear here.</p>}
              {spec !== null && (
                <>
                  {adapter.renderSpecPanel(spec, patch)}
                  <button className="gen-agent__build" onClick={build} disabled={busy || !adapter.specName(spec).trim()}>
                    {adapter.buildButtonLabel}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {phase === 'build' && draft && (
          <div className="gen-agent__build-view">
            <div className="gen-agent__slugline gen-agent__slugline--build">
              Will save as <code>{adapter.savePathLabel(draft.slug)}</code>
            </div>
            <pre className="gen-agent__preview">{draft.content}</pre>
            <div className="gen-agent__build-actions">
              <button onClick={() => { setPhase('spec'); setDraft(null) }} disabled={busy}>Back to spec</button>
              <button onClick={build} disabled={busy}>Regenerate</button>
              <button className="gen-agent__save" onClick={() => save()} disabled={busy}>
                {busy ? 'Saving...' : adapter.saveButtonLabel}
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && saved && (
          <div className="gen-agent__done">
            <div className="gen-agent__done-check">Done</div>
            <div className="gen-agent__done-title">{adapter.savedTitle}</div>
            <div className="gen-agent__done-name">{saved.name}</div>
            <div className="gen-agent__slugline">
              Saved to <code>{adapter.savePathLabel(saved.slug)}</code>
            </div>
            <p className="gen-agent__done-hint">{adapter.savedHint}</p>
            <div className="gen-agent__done-actions">
              <button onClick={reset}>Generate another</button>
              <button className="gen-agent__save" onClick={() => { reset(); onClose() }}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
