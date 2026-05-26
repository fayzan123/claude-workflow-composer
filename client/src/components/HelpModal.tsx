import React, { useEffect, useRef } from 'react'
import './HelpModal.css'

interface Props {
  onClose: () => void
}

export function HelpModal({ onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div className="help-overlay" ref={overlayRef} onClick={handleOverlayClick} role="dialog" aria-modal aria-label="Help">
      <div className="help-modal">
        <div className="help-modal__header">
          <h2 className="help-modal__title">How it works</h2>
          <button className="help-modal__close" onClick={onClose} type="button" aria-label="Close help">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="help-modal__body">
          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">What are agents?</h3>
              <p className="help-section__body">
                Agents are Claude Code sub-agents — specialised AI roles you give to Claude. Each agent has a name, a description of what it does, and a list of skills. When you run a workflow, each agent handles its assigned step using Claude Code under the hood.
              </p>
              <p className="help-section__body">
                Think of them like roles on a team: a <em>Backend Architect</em> handles API design, a <em>Frontend Developer</em> handles UI, and so on. You wire them together to form a pipeline.
              </p>
            </div>
          </section>

          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">What are skills?</h3>
              <p className="help-section__body">
                Skills are reusable instruction sets — markdown files that tell an agent <em>how</em> to approach a task. A skill might say "always write tests first" or "follow this design system." Attaching a skill to an agent loads those instructions every time that agent runs.
              </p>
              <p className="help-section__body">
                Skills live in <code>~/.claude/skills/</code>. You can write your own or grab community-made ones from the <strong>Discover</strong> tab.
              </p>
            </div>
          </section>

          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M17.5 14v3m0 3h.01M17.5 14a3.5 3.5 0 1 1 0 7" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">Building a workflow</h3>
              <p className="help-section__body">
                Drag an agent from the <strong>My Agents</strong> sidebar onto the canvas to add it as a step. Drag another agent on top of a node's output handle (the circle on the right edge) and release over another node's input handle (left edge) to connect them — this creates a handoff, meaning the first agent's output flows into the second.
              </p>
              <ul className="help-section__list">
                <li><strong>Add an agent:</strong> drag from the sidebar onto the canvas.</li>
                <li><strong>Connect agents:</strong> drag from one node's right handle to another's left handle.</li>
                <li><strong>Move nodes:</strong> click and drag any node to reposition it.</li>
                <li><strong>Edit a node:</strong> click a node to open its settings panel on the right.</li>
                <li><strong>Delete:</strong> select a node or edge and use the panel's delete button.</li>
              </ul>
            </div>
          </section>

          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">Adding skills to an agent</h3>
              <p className="help-section__body">
                Click any agent node on the canvas to open its panel. Switch to the <strong>Skills</strong> tab in the sidebar, then drag a skill card into the node panel's skills list — or use the "Add skill" field in the panel to type a skill name directly.
              </p>
              <p className="help-section__body">
                Each skill appears as a badge on the node so you can see at a glance what capabilities the agent has.
              </p>
            </div>
          </section>

          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">The Discover tab</h3>
              <p className="help-section__body">
                Open the <strong>Discover</strong> tab in the left sidebar to find community-made agent definitions and skill packs. These are GitHub repositories you can clone or browse to find ready-made agents and skills. Download ones you like, place them in the right folder, and they'll show up in your sidebar automatically.
              </p>
            </div>
          </section>

          <section className="help-section">
            <div className="help-section__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div>
              <h3 className="help-section__heading">Exporting a workflow</h3>
              <p className="help-section__body">
                Once your workflow is ready, click <strong>Export</strong> in the top bar. This writes a <code>.cwc</code> file that Claude Code can read and execute — it's the file that tells Claude which agents to run, in what order, and with which skills.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
