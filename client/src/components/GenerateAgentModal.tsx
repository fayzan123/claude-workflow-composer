import { useState } from 'react'
import { api } from '../lib/api.ts'
import type { AgentSpec } from '../../../src/agent-generator.ts'
import { MarkdownViewer } from './MarkdownViewer.tsx'
import './GenerateAgentModal.css'

interface Props {
  onClose: () => void
  onCreated: (slug: string) => void
}

type ChatMsg = { role: 'user' | 'assistant'; text: string }

export function GenerateAgentModal({ onClose, onCreated }: Props) {
  const [phase, setPhase] = useState<'spec' | 'build'>('spec')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [spec, setSpec] = useState<AgentSpec | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ content: string; slug: string } | null>(null)

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

  async function save(overwrite = false) {
    if (!draft || busy) return
    setError(null)
    setBusy(true)
    try {
      const { slug } = await api.saveAgent(draft.slug, draft.content, overwrite)
      onCreated(slug)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      if (/already exists/i.test(msg) && !overwrite) {
        if (window.confirm(`${msg}\n\nOverwrite it?`)) { await save(true); return }
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  function updateSpec<K extends keyof AgentSpec>(key: K, value: AgentSpec[K]) {
    setSpec((s) => (s ? { ...s, [key]: value } : s))
  }

  return (
    <div className="gen-agent-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gen-agent" role="dialog" aria-modal="true" aria-label="Generate agent">
        <div className="gen-agent__header">
          <span className="gen-agent__title">Generate agent</span>
          <button className="gen-agent__close" onClick={onClose} aria-label="Close">×</button>
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
                      {spec.keyBehaviors.map((b, i) => <li key={i}>{b}</li>)}
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
            <MarkdownViewer content={draft.content} title={spec?.name ?? 'Agent'} onClose={() => setPhase('spec')} />
            <div className="gen-agent__build-actions">
              <button onClick={() => setPhase('spec')} disabled={busy}>← Back to spec</button>
              <button onClick={build} disabled={busy}>Regenerate</button>
              <button className="gen-agent__save" onClick={() => save(false)} disabled={busy}>
                Save to ~/.claude/agents/
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
