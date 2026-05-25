import React, { useState } from 'react'
import type { CwcNode, CwcAgent } from '../../../../src/schema.ts'
import type { WorkflowAction } from '../../hooks/useWorkflow.ts'
import { slugify } from '../../../../src/slugify.ts'
import './NodePanel.css'

const AVAILABLE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'NotebookEdit', 'LSP']

interface Props {
  node: CwcNode
  isEntryNode: boolean
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
}

export function NodePanel({ node, isEntryNode, dispatch, onClose }: Props) {
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [newSkill, setNewSkill] = useState('')

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

  function handleToolToggle(tool: string) {
    const current = node.agent.tools ?? []
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]
    updateAgent({ tools: next })
  }

  function handleAddSkill() {
    const trimmed = newSkill.trim()
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

  function handleStartTriggerChange(e: React.ChangeEvent<HTMLInputElement>) {
    // agent: {} intentional — UPDATE_NODE merges agent fields; only startTrigger is changing
    dispatch({ type: 'UPDATE_NODE', payload: { nodeId: node.id, agent: {}, startTrigger: e.target.value } })
  }

  const slugPreview = slugify(node.agent.name) || '...'

  return (
    <aside className="node-panel">
      <div className="node-panel__header">
        <span className="node-panel__title">Node Editor</span>
        <button className="node-panel__close" onClick={onClose} aria-label="Close panel">×</button>
      </div>

      <div className="node-panel__body">
        <div className="node-panel__field">
          <label className="node-panel__label">Name</label>
          <input
            className="node-panel__input"
            type="text"
            value={node.agent.name}
            onChange={handleNameChange}
            placeholder="Agent name"
          />
          <div className="node-panel__slug-preview">
            Slug: <code>{slugPreview}</code>
          </div>
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label">Description</label>
          <textarea
            className="node-panel__textarea"
            value={node.agent.description}
            onChange={handleDescChange}
            placeholder="What does this agent do?"
            rows={3}
          />
        </div>

        <div className="node-panel__field">
          <label className="node-panel__label node-panel__label--required">Completion Criteria *</label>
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
            <input
              className="node-panel__input"
              type="text"
              value={newSkill}
              onChange={(e) => setNewSkill(e.target.value)}
              onKeyDown={handleSkillKeyDown}
              placeholder="Add skill..."
            />
            <button className="node-panel__btn" onClick={handleAddSkill}>Add</button>
          </div>
        </div>

        <div className="node-panel__field">
          <button
            className="node-panel__collapsible"
            onClick={() => setPromptExpanded((v) => !v)}
          >
            {promptExpanded ? '▼' : '▶'} System Prompt
          </button>
          {promptExpanded && (
            <textarea
              className="node-panel__textarea node-panel__textarea--mono"
              value={node.agent.systemPrompt ?? ''}
              onChange={handleSystemPromptChange}
              placeholder="Optional system prompt..."
              rows={6}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
