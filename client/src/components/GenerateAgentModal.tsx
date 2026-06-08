import { api } from '../lib/api.ts'
import type { AgentSpec } from '../../../src/agent-generator.ts'
import { agentSlug } from '../../../src/slugify.ts'
import { GenerateModal, type GenerateAdapter } from './GenerateModal.tsx'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}

const agentAdapter: GenerateAdapter<AgentSpec> = {
  title: 'Generate agent',
  noun: 'agent',
  inputPlaceholderEmpty: 'e.g. an agent that reviews my SQL migrations',
  inputPlaceholderRefine: 'Refine it… e.g. "make it read-only"',
  buildingStatus: 'Writing the agent…',
  buildButtonLabel: 'Build agent →',
  saveButtonLabel: 'Save to ~/.claude/agents/',
  savedTitle: 'Agent created',
  savedHint: 'It’s now in your My Agents list and ready to drag onto the canvas.',
  specName: (s) => s.name,
  savePathLabel: (slug) => `~/.claude/agents/${slug}.md`,
  api: {
    spec: api.agentGen.spec,
    build: api.agentGen.build,
    save: api.saveAgent,
  },
  renderSpecPanel: (spec, patch) => (
    <>
      <label className="gen-agent__field">
        <span>Name</span>
        <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <div className="gen-agent__slugline">
        Saves as <code>~/.claude/agents/{agentSlug(spec.name)}.md</code>
      </div>
      <label className="gen-agent__field">
        <span>Description (trigger)</span>
        <textarea value={spec.description} onChange={(e) => patch({ description: e.target.value })} />
      </label>
      <label className="gen-agent__field">
        <span>When to use</span>
        <textarea value={spec.whenToUse} onChange={(e) => patch({ whenToUse: e.target.value })} />
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
          {spec.keyBehaviors.map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}
        </ul>
      </div>
    </>
  ),
}

export function GenerateAgentModal({ open, onClose, onCreated }: Props) {
  return <GenerateModal open={open} onClose={onClose} onCreated={onCreated} adapter={agentAdapter} />
}
