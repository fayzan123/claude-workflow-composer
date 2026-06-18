import React, { useEffect, useState } from 'react'
import type { CwcNode, CwcAgent, CwcEdge, TerminalType, CwcFile } from '../../../../src/schema.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import type { SkillEntry } from '../../../../src/server/api/skills.ts'
import { slugify } from '../../../../src/slugify.ts'
import { CLAUDE_MODELS } from '../../lib/models.ts'
import { api } from '../../lib/api.ts'
import { FieldHint } from '../common/FieldHint.tsx'
import { agentToMarkdown, parseAgentMarkdown } from '../../lib/agentMarkdown.ts'
import './NodePanel.css'

const AVAILABLE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Skill', 'Task', 'TodoWrite', 'NotebookEdit', 'LSP']

interface Props {
  node: CwcNode
  isEntryNode: boolean
  terminalEdge: CwcEdge | null
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
  onDelete: () => void
  /** When true, omits the outer <aside> wrapper and header row (title/Delete/close).
   *  Use inside a Drawer so the Drawer shell provides the chrome. */
  embedded?: boolean
}

export function NodePanel({ node, isEntryNode, terminalEdge, workflow, dispatch, onClose, onDelete, embedded }: Props) {
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [newSkill, setNewSkill] = useState('')
  const [skillFocused, setSkillFocused] = useState(false)
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([])
  const [mode, setMode] = useState<'form' | 'markdown'>('form')
  const [mdDraft, setMdDraft] = useState('')
  const [mdError, setMdError] = useState<string | null>(null)

  useEffect(() => {
    api.skills().then(setInstalledSkills).catch(() => {})
  }, [])

  // Re-seed the markdown draft only when entering markdown mode or selecting a different node —
  // not on every field change, so form edits don't clobber an in-progress markdown edit.
  useEffect(() => {
    if (mode === 'markdown') { setMdDraft(agentToMarkdown(node.agent)); setMdError(null) }
  }, [mode, node.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMdChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setMdDraft(v)
    const r = parseAgentMarkdown(v)
    if (r.ok) { setMdError(null); updateAgent(r.patch) }
    else setMdError(r.error)
  }

  function updateAgent(agentPartial: Partial<CwcAgent>) {
    dispatch({ type: 'UPDATE_NODE', payload: { nodeId: node.id, agent: agentPartial } })
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    updateAgent({ name: e.target.value })
  }

  function handleDescChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    updateAgent({ description: e.target.value })
  }

  function handleCriteriaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    updateAgent({ completionCriteria: e.target.value })
  }

  function handleSystemPromptChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    updateAgent({ systemPrompt: e.target.value })
  }

  function handleModelChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    // Passing undefined causes JSON.stringify to omit the key entirely,
    // so exported agent frontmatter correctly has no `model:` line.
    updateAgent({ model: value === '' ? undefined : value })
  }

  function handleToolToggle(tool: string) {
    const current = node.agent.tools ?? []
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]
    updateAgent({ tools: next })
  }

  function handleAddSkill(value?: string) {
    const trimmed = (value ?? newSkill).trim()
    if (!trimmed) return
    const current = node.agent.skills ?? []
    if (!current.includes(trimmed)) {
      updateAgent({ skills: [...current, trimmed] })
    }
    setNewSkill('')
  }

  function handleRemoveSkill(skill: string) {
    const current = node.agent.skills ?? []
    updateAgent({ skills: current.filter((s) => s !== skill) })
  }

  function handleSkillKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddSkill()
    }
  }

  function handleTerminalTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    if (value === '') {
      if (terminalEdge) {
        dispatch({ type: 'REMOVE_EDGE', payload: { edgeId: terminalEdge.id } })
      }
    } else {
      const type = value as TerminalType
      if (terminalEdge) {
        dispatch({ type: 'UPDATE_EDGE', payload: { edgeId: terminalEdge.id, terminalType: type } })
      } else {
        dispatch({ type: 'ADD_EDGE', payload: { from: node.id, to: null, trigger: `${node.agent.name} ${type}`, terminalType: type } })
      }
    }
  }

  function handleStartTriggerChange(e: React.ChangeEvent<HTMLInputElement>) {
    // agent: {} intentional — UPDATE_NODE merges agent fields; only startTrigger is changing
    dispatch({ type: 'UPDATE_NODE', payload: { nodeId: node.id, agent: {}, startTrigger: e.target.value } })
  }

  function handleDispatchModeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as 'parallel' | 'conditional' | ''
    dispatch({ type: 'UPDATE_NODE', payload: { nodeId: node.id, agent: {}, dispatchMode: value === '' ? undefined : value } })
  }

  const slugPreview = slugify(node.agent.name) || '...'
  const isRef = !!node.agentRef

  const addedSkills = node.agent.skills ?? []
  const query = newSkill.trim().toLowerCase()
  const skillSuggestions = installedSkills
    .filter((s) => !addedSkills.includes(s.namespacedSlug))
    .filter((s) =>
      !query ||
      s.namespacedSlug.toLowerCase().includes(query) ||
      s.name.toLowerCase().includes(query)
    )
    .slice(0, 8)

  const isGate = node.nodeType === 'gate'

  const gateBody = (
    <div className="node-panel__body">
      <div className="node-panel__field">
        <label className="node-panel__label">Gate label</label>
        <input
          className="node-panel__input"
          type="text"
          value={node.agent.name}
          onChange={handleNameChange}
          placeholder="Gate name"
        />
      </div>
      <div className="node-panel__field">
        <label className="node-panel__label">Reviewer instructions</label>
        <textarea
          className="node-panel__textarea"
          value={node.agent.description}
          onChange={handleDescChange}
          placeholder="What should the summary cover? What should the reviewer check?"
          rows={4}
        />
      </div>
    </div>
  )

  if (isGate) {
    if (embedded) return gateBody
    return (
      <aside className="node-panel">
        <div className="node-panel__header">
          <span className="node-panel__title">Approval Gate</span>
          <button className="node-panel__delete" onClick={onDelete} aria-label="Delete node">Delete</button>
          <button className="node-panel__close" onClick={onClose} aria-label="Close panel">×</button>
        </div>
        {gateBody}
      </aside>
    )
  }

  const nodeBody = (
    <div className="node-panel__body">
        {isRef && (
          <div className="node-panel__ref-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Reference — uses <code>{node.agentRef}</code>
          </div>
        )}

        {!isRef && (
          <div className="node-panel__modes" role="tablist" aria-label="Editor mode">
            <button type="button" role="tab" aria-selected={mode === 'form'} className={`node-panel__mode${mode === 'form' ? ' is-on' : ''}`} onClick={() => setMode('form')}>Form</button>
            <button type="button" role="tab" aria-selected={mode === 'markdown'} className={`node-panel__mode${mode === 'markdown' ? ' is-on' : ''}`} onClick={() => setMode('markdown')}>Markdown</button>
          </div>
        )}

        {mode === 'markdown' && !isRef && (
          <div className="node-panel__field">
            <textarea
              className="node-panel__md"
              value={mdDraft}
              onChange={handleMdChange}
              spellCheck={false}
              rows={24}
              aria-label="Agent markdown source"
            />
            {mdError
              ? <div className="node-panel__md-error">{mdError}</div>
              : <div className="node-panel__md-note">Editing the agent's raw <code>.md</code> — frontmatter + system prompt. Completion criteria, skills &amp; wiring stay in Form view.</div>}
          </div>
        )}

        {(mode === 'form' || isRef) && (<>
        <div className="node-panel__field">
          <label className="node-panel__label">Name</label>
          <FieldHint id="node.name" />
          <input
            className="node-panel__input"
            type="text"
            value={node.agent.name}
            onChange={isRef ? undefined : handleNameChange}
            readOnly={isRef}
            placeholder="Agent name"
          />
          <div className="node-panel__slug-preview">
            {isRef
              ? <>Agent file: <code>{node.agentRef}</code> — name is read-only</>
              : <>Slug: <code>{slugPreview}</code></>
            }
          </div>
        </div>

        {!isRef && (
        <div className="node-panel__field">
          <label className="node-panel__label">Description</label>
          <FieldHint id="node.description" />
          <textarea
            className="node-panel__textarea"
            value={node.agent.description}
            onChange={handleDescChange}
            placeholder="What does this agent do?"
            rows={3}
          />
        </div>
        )}

        <div className="node-panel__field">
          <label className="node-panel__label">Model</label>
          <FieldHint id="node.model" />
          <select
            className="node-panel__select"
            value={node.agent.model ?? ''}
            onChange={handleModelChange}
          >
            <option value="">Default</option>
            {CLAUDE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label node-panel__label--required">Completion Criteria *</label>
          <FieldHint id="node.completionCriteria" />
          <textarea
            className="node-panel__textarea"
            value={node.agent.completionCriteria}
            onChange={handleCriteriaChange}
            placeholder="When is this agent done?"
            rows={3}
          />
        </div>

        {isEntryNode && (
          <div className="node-panel__field">
            <label className="node-panel__label">Start Trigger</label>
            <FieldHint id="node.startTrigger" />
            <input
              className="node-panel__input"
              type="text"
              value={node.startTrigger ?? ''}
              onChange={handleStartTriggerChange}
              placeholder="What triggers this workflow?"
            />
          </div>
        )}

        <div className="node-panel__field">
          <label className="node-panel__label">Tools</label>
          <FieldHint id="node.tools" />
          <div className="node-panel__checkboxes">
            {AVAILABLE_TOOLS.map((tool) => (
              <label key={tool} className="node-panel__checkbox-label">
                <input
                  type="checkbox"
                  checked={(node.agent.tools ?? []).includes(tool)}
                  onChange={() => handleToolToggle(tool)}
                />
                <span>{tool}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label">Skills</label>
          <FieldHint id="node.skills" />
          <div className="node-panel__chips">
            {(node.agent.skills ?? []).map((skill) => (
              <span key={skill} className="node-panel__chip">
                {skill}
                <button
                  className="node-panel__chip-remove"
                  onClick={() => handleRemoveSkill(skill)}
                  aria-label={`Remove skill ${skill}`}
                >×</button>
              </span>
            ))}
          </div>
          <div className="node-panel__skill-add">
            <div className="node-panel__skill-input-wrap">
              <input
                className="node-panel__input"
                type="text"
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={handleSkillKeyDown}
                onFocus={() => setSkillFocused(true)}
                onBlur={() => setSkillFocused(false)}
                placeholder="Add skill..."
              />
              {skillFocused && skillSuggestions.length > 0 && (
                <ul className="node-panel__skill-suggestions">
                  {skillSuggestions.map((s) => (
                    <li key={s.namespacedSlug}>
                      <button
                        type="button"
                        className="node-panel__skill-suggestion"
                        onMouseDown={(e) => { e.preventDefault(); handleAddSkill(s.namespacedSlug) }}
                      >
                        <span className="node-panel__skill-suggestion-slug">{s.namespacedSlug}</span>
                        {s.name && s.name !== s.namespacedSlug && (
                          <span className="node-panel__skill-suggestion-name">{s.name}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="node-panel__btn" onClick={() => handleAddSkill()}>Add</button>
          </div>
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label">Dispatch Mode</label>
          <FieldHint id="node.dispatchMode" />
          <select
            className="node-panel__select"
            value={node.dispatchMode ?? ''}
            onChange={handleDispatchModeChange}
          >
            <option value="">Parallel fan-out (default)</option>
            <option value="parallel">Parallel fan-out</option>
            <option value="conditional">Conditional branch (router)</option>
          </select>
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label">Terminal Type</label>
          <FieldHint id="node.terminalType" />
          <select
            className="node-panel__select"
            value={terminalEdge ? (terminalEdge.terminalType ?? 'complete') : ''}
            onChange={handleTerminalTypeChange}
          >
            <option value="">Not an end node</option>
            <option value="complete">Complete — workflow succeeded</option>
            <option value="escalated">Escalated — needs human review</option>
            <option value="aborted">Aborted — workflow failed</option>
          </select>
        </div>

        <div className="node-panel__field">
          <button
            className="node-panel__collapsible"
            onClick={() => setPromptExpanded((v) => !v)}
          >
            {promptExpanded ? '▼' : '▶'} System Prompt
          </button>
          {promptExpanded && (
            <>
              <FieldHint id="node.systemPrompt" />
              <textarea
                className="node-panel__textarea node-panel__textarea--mono"
                value={node.agent.systemPrompt ?? ''}
                onChange={handleSystemPromptChange}
                placeholder="Optional system prompt..."
                rows={6}
              />
            </>
          )}
        </div>
        </>)}
      </div>
  )

  if (embedded) return nodeBody
  return (
    <aside className="node-panel">
      <div className="node-panel__header">
        <span className="node-panel__title">Node Editor</span>
        <button className="node-panel__delete" onClick={onDelete} aria-label="Delete node">Delete</button>
        <button className="node-panel__close" onClick={onClose} aria-label="Close panel">×</button>
      </div>
      {nodeBody}
    </aside>
  )
}
