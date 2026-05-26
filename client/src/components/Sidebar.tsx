import { useState } from 'react'
import { MyAgentsTab } from './sidebar/MyAgentsTab.tsx'
import { SkillsPanel } from './sidebar/SkillsPanel.tsx'
import { DiscoverTab } from './sidebar/DiscoverTab.tsx'
import './Sidebar.css'

type Tab = 'my-agents' | 'skills' | 'discover'

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
        <button
          className={`sidebar__tab${activeTab === 'discover' ? ' sidebar__tab--active' : ''}`}
          onClick={() => setActiveTab('discover')}
        >
          Discover
        </button>
      </div>
      <div className="sidebar__content">
        {activeTab === 'my-agents' && <MyAgentsTab />}
        {activeTab === 'skills' && <SkillsPanel />}
        {activeTab === 'discover' && <DiscoverTab />}
      </div>
    </div>
  )
}
