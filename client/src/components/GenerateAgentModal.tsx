import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import type { AgentSpec } from '../../../src/agent-generator.ts'
import { agentSlug } from '../../../src/slugify.ts'
import './GenerateAgentModal.css'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}

type ChatMsg = { role: 'user' | 'assistant'; text: string }

export function GenerateAgentModal({ open, onClose, onCreated }: Props) {
  const [phase, setPhase] = useState<'spec' | 'build' | 'done'>('spec')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [spec, setSpec] = useState<AgentSpec | null>(null)
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
    setStatus('Refining…')
    setMessages((m) => [...m, { role: 'user', text: msg }])
    setInput('')
    try {
      const { spec: newSpec, sessionId: sid } = await api.agentGen.spec(msg, sessionId)
      setSpec(newSpec)
      setSessionId(sid)
      setMessages((m) => [...m, { role: 'assistant', text: `Updated spec: ${newSpec.name}` }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function build() {
    if (!spec || busy) return
    setError(null)
    setBusy(true)
    setStatus('Writing the agent…')
    try {
      const result = await api.agentGen.build(spec, sessionId)
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
        result = await api.saveAgent(draft.slug, draft.content, false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Save failed'
        if (/already exists/i.test(msg) && window.confirm(`${msg}\n\nOverwrite it?`)) {
          try {
            result = await api.saveAgent(draft.slug, draft.content, true)
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
      setSaved({ name: spec?.name ?? result.slug, slug: result.slug })
      setPhase('done')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setPhase('spec')
    setMessages([])
    setInput('')
    setSpec(null)
    setSessionId(undefined)
    setDraft(null)
    setSaved(null)
    setError(null)
  }

  const hasProgress = messages.length > 0 || spec !== null || draft !== null

  function startNew() {
    if (busy) return
    if (!hasProgress || window.confirm('Start over? This clears the current agent.')) reset()
  }

  function updateSpec<K extends keyof AgentSpec>(key: K, value: AgentSpec[K]) {
    setSpec((s) => (s ? { ...s, [key]: value } : s))
  }

  if (!open) return null

  return createPortal(
    <div className="gen-agent-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gen-agent" role="dialog" aria-modal="true" aria-label="Generate agent">
        <div className="gen-agent__header">
          <span className="gen-agent__title">Generate agent</span>
          <div className="gen-agent__header-actions">
            {phase !== 'done' && hasProgress && (
              <button className="gen-agent__newbtn" onClick={startNew} disabled={busy}>↺ Start new</button>
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
                  <p className="gen-agent__hint">Describe the agent you want. What should it do, and when should it be used?</p>
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
                  placeholder={spec ? 'Refine it… e.g. "make it read-only"' : 'e.g. an agent that reviews my SQL migrations'}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMessage() }}
                />
                <button className="gen-agent__send" onClick={sendMessage} disabled={busy || !input.trim()}>
                  {spec ? 'Refine' : 'Refine →'}
                </button>
              </div>
            </div>

            <div className="gen-agent__spec">
              {!spec && <p className="gen-agent__hint">The proposed spec will appear here.</p>}
              {spec && (
                <>
                  <label className="gen-agent__field">
                    <span>Name</span>
                    <input value={spec.name} onChange={(e) => updateSpec('name', e.target.value)} />
                  </label>
                  <div className="gen-agent__slugline">
                    Saves as <code>~/.claude/agents/{agentSlug(spec.name)}.md</code>
                  </div>
                  <label className="gen-agent__field">
                    <span>Description (trigger)</span>
                    <textarea value={spec.description} onChange={(e) => updateSpec('description', e.target.value)} />
                  </label>
                  <label className="gen-agent__field">
                    <span>When to use</span>
                    <textarea value={spec.whenToUse} onChange={(e) => updateSpec('whenToUse', e.target.value)} />
                  </label>
                  <div className="gen-agent__field">
                    <span>Tools</span>
                    <div className="gen-agent__chips">
                      {spec.suggestedTools.length === 0 && <em>all tools</em>}
                      {spec.suggestedTools.map((t) => <span key={t} className="gen-agent__chip">{t}</span>)}
                    </div>
                  </div>
                  <div className="gen-agent__field">
                    <span>Key behaviors</span>
                    <ul className="gen-agent__behaviors">
                      {spec.keyBehaviors.map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}
                    </ul>
                  </div>
                  <button className="gen-agent__build" onClick={build} disabled={busy || !spec.name.trim()}>
                    Build agent →
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {phase === 'build' && draft && (
          <div className="gen-agent__build-view">
            <div className="gen-agent__slugline gen-agent__slugline--build">
              Will save as <code>~/.claude/agents/{draft.slug}.md</code>
            </div>
            <pre className="gen-agent__preview">{draft.content}</pre>
            <div className="gen-agent__build-actions">
              <button onClick={() => { setPhase('spec'); setDraft(null) }} disabled={busy}>← Back to spec</button>
              <button onClick={build} disabled={busy}>Regenerate</button>
              <button className="gen-agent__save" onClick={() => save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save to ~/.claude/agents/'}
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && saved && (
          <div className="gen-agent__done">
            <div className="gen-agent__done-check">✓</div>
            <div className="gen-agent__done-title">Agent created</div>
            <div className="gen-agent__done-name">{saved.name}</div>
            <div className="gen-agent__slugline">
              Saved to <code>~/.claude/agents/{saved.slug}.md</code>
            </div>
            <p className="gen-agent__done-hint">It’s now in your My Agents list and ready to drag onto the canvas.</p>
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
