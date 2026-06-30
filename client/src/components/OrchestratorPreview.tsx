import React, { useMemo } from 'react'
import type { CwcFile } from '../types.ts'
import { generateOrchestratorBody, collectNodeOverrides } from '../../../src/workflow/prose-generator.ts'
import './OrchestratorPreview.css'

interface Props {
  workflow: CwcFile
  onClose: () => void
}

// Render the small markdown subset the prose generator emits (bold, inline code).
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let lastIndex = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index))
    const token = m[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<code key={key++} className="op__code">{token.slice(1, -1)}</code>)
    }
    lastIndex = m.index + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function renderBlock(line: string, i: number): React.ReactNode {
  if (line.trim() === '') return null
  if (line.startsWith('## ')) return <h3 key={i} className="op__heading">{renderInline(line.slice(3))}</h3>
  if (line.startsWith('> ')) return <blockquote key={i} className="op__quote">{renderInline(line.slice(2))}</blockquote>

  const bullet = line.match(/^\s*-\s+(.*)$/)
  if (bullet) return <div key={i} className="op__bullet">{renderInline(bullet[1])}</div>

  const numbered = line.match(/^(\d+)\.\s+(.*)$/)
  if (numbered) {
    return (
      <div key={i} className="op__step">
        <span className="op__step-num">{numbered[1]}</span>
        <span className="op__step-text">{renderInline(numbered[2])}</span>
      </div>
    )
  }

  return <p key={i} className="op__para">{renderInline(line)}</p>
}

export function OrchestratorPreview({ workflow, onClose }: Props) {
  const body = useMemo(
    () => generateOrchestratorBody(
      workflow.nodes,
      workflow.edges,
      workflow.meta.name,
      collectNodeOverrides(workflow.nodes),
    ),
    [workflow],
  )

  const hasNodes = workflow.nodes.length > 0

  return (
    <aside className="orchestrator-preview" aria-label="Orchestrator preview">
      <div className="op__header">
        <div className="op__title-wrap">
          <span className="op__eyebrow">Live preview</span>
          <h2 className="op__title">Orchestrator</h2>
        </div>
        <button className="op__close" onClick={onClose} type="button" aria-label="Close preview">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <p className="op__subtitle">The exact pipeline prose Claude Code will follow. Updates as you edit.</p>

      <div className="op__body">
        {hasNodes ? (
          body.split('\n').map(renderBlock)
        ) : (
          <div className="op__empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6m0 6v6m11-7h-6m-6 0H1" />
            </svg>
            <p>Add an agent to the canvas to see the orchestrator pipeline.</p>
          </div>
        )}
      </div>
    </aside>
  )
}
