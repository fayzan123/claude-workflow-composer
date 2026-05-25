import React, { useState } from 'react'
import { AgentLibrary } from './sidebar/AgentLibrary.tsx'
import { MyAgentsTab } from './sidebar/MyAgentsTab.tsx'
import { SkillsPanel } from './sidebar/SkillsPanel.tsx'
import './Sidebar.css'

type Tab = 'library' | 'my-agents' | 'skills'

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<Tab>('library')

  return (
    <div className="sidebar">
      <div className="sidebar__tabs">
        <button
          className={`sidebar__tab${activeTab === 'library' ? ' sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('library')}
        >
          Library
        </button>
        <button
          className={`sidebar__tab${activeTab === 'my-agents' ? ' sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('my-agents')}
        >
          My Agents
        </button>
        <button
          className={`sidebar__tab${activeTab === 'skills' ? ' sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('skills')}
        >
          Skills
        </button>
      </div>
      <div className="sidebar__content">
        {activeTab === 'library' && <AgentLibrary />}
        {activeTab === 'my-agents' && <MyAgentsTab />}
        {activeTab === 'skills' && <SkillsPanel />}
      </div>
    </div>
  )
}
