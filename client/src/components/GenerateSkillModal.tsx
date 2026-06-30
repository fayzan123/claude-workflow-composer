import { api } from '../lib/api.ts'
import type { SkillSpec } from '../../../src/generation/skill-generator.ts'
import { skillSlug } from '../../../src/slugify.ts'
import { GenerateModal, type GenerateAdapter } from './GenerateModal.tsx'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}

const skillAdapter: GenerateAdapter<SkillSpec> = {
  title: 'Generate skill',
  noun: 'skill',
  inputPlaceholderEmpty: 'e.g. a skill that reviews SQL migrations for safety',
  inputPlaceholderRefine: 'Refine it... e.g. "add a rollback check step"',
  buildingStatus: 'Writing the skill...',
  buildButtonLabel: 'Build skill',
  saveButtonLabel: 'Save to ~/.claude/skills/',
  savedTitle: 'Skill created',
  savedHint: "It's now in your Skills list and can be attached to agents on the canvas.",
  specName: (s) => s.name,
  savePathLabel: (slug) => `~/.claude/skills/${slug}/SKILL.md`,
  api: {
    spec: api.skillGen.spec,
    build: api.skillGen.build,
    save: api.saveSkill,
  },
  renderSpecPanel: (spec, patch) => (
    <>
      <label className="gen-agent__field">
        <span>Name (slug)</span>
        <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <div className="gen-agent__slugline">
        Saves as <code>~/.claude/skills/{skillSlug(spec.name)}/SKILL.md</code>
      </div>
      <label className="gen-agent__field">
        <span>Description (trigger)</span>
        <textarea value={spec.description} onChange={(e) => patch({ description: e.target.value })} />
      </label>
      <div className="gen-agent__field">
        <span>Steps</span>
        <ul className="gen-agent__behaviors">
          {spec.steps.map((s, i) => <li key={`${i}-${s}`}>{s}</li>)}
        </ul>
      </div>
    </>
  ),
}

export function GenerateSkillModal({ open, onClose, onCreated }: Props) {
  return <GenerateModal open={open} onClose={onClose} onCreated={onCreated} adapter={skillAdapter} />
}
