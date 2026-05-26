import './DiscoverTab.css'

interface ResourceCard {
  title: string
  description: string
  url: string
  label: string
}

const AGENT_RESOURCES: ResourceCard[] = [
  {
    title: 'agency-agents',
    description: 'A curated collection of Claude Code agent definitions by msitarzewski.',
    url: 'https://github.com/msitarzewski/agency-agents',
    label: 'msitarzewski/agency-agents',
  },
]

const SKILL_RESOURCES: ResourceCard[] = [
  {
    title: 'claude-skills',
    description: 'Community-contributed skills for Claude Code by alirezarezvani.',
    url: 'https://github.com/alirezarezvani/claude-skills',
    label: 'alirezarezvani/claude-skills',
  },
]

function ResourceSection({ heading, resources }: { heading: string; resources: ResourceCard[] }) {
  return (
    <div className="discover__section">
      <div className="discover__section-label">{heading}</div>
      {resources.map((r) => (
        <a
          key={r.url}
          className="discover__card"
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <strong className="discover__card-title">{r.title}</strong>
          <p className="discover__card-desc">{r.description}</p>
          <span className="discover__card-slug">{r.label}</span>
        </a>
      ))}
    </div>
  )
}

export function DiscoverTab() {
  return (
    <div className="discover">
      <div className="discover__intro">
        Browse community repositories and download agents or skills to add to your{' '}
        <code>~/.claude/</code> directory.
      </div>
      <div className="discover__list">
        <ResourceSection heading="Agents" resources={AGENT_RESOURCES} />
        <ResourceSection heading="Skills" resources={SKILL_RESOURCES} />
      </div>
    </div>
  )
}
