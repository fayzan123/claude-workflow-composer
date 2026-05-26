import React from 'react'
import { AGENT_LIBRARY } from '../../lib/agentLibrary.ts'
import './AgentLibrary.css'

export function AgentLibrary() {
  return (
    <div className="agent-library">
      {AGENT_LIBRARY.map((agent) => (
        <div
          key={agent.name}
          className="agent-library__card"
          draggable
          onDragStart={(e) => e.dataTransfer.setData('application/cwc-agent', JSON.stringify(agent))}
        >
          <strong className="agent-library__name">{agent.name}</strong>
          <p className="agent-library__desc">{agent.description}</p>
          <span className="agent-library__category">{agent.category}</span>
        </div>
      ))}
    </div>
  )
}
