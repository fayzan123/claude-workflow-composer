import { useState } from 'react'
import { MyAgentsTab } from './sidebar/MyAgentsTab.tsx'
import { SkillsPanel } from './sidebar/SkillsPanel.tsx'
import './Sidebar.css'

type Tab = 'my-agents' | 'skills'

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<Tab>('my-agents')

  return (
    <div className="sidebar">
      <div className="sidebar__tabs">
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
        {activeTab === 'my-agents' && <MyAgentsTab />}
        {activeTab === 'skills' && <SkillsPanel />}
      </div>
    </div>
  )
}
