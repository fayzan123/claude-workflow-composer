import { useNavigate } from 'react-router-dom'
import { ArtifactBadge } from '../../components/common/ArtifactBadge.tsx'
import { artifactTierOf, hasExplicitLoopStop, isBespokeNode } from '../../lib/artifact.ts'
import { describeCron } from '../../lib/schedule-cron.ts'
import type { ModeProps } from '../modeProps.ts'
import './SkillBuildMode.css'

interface Props extends ModeProps {
  workflowId: string
  onGraduate: () => void
}

export function SkillBuildMode({ workflow, dispatch, workflowId, onGraduate }: Props) {
  const navigate = useNavigate()
  const tier = artifactTierOf(workflow)
  const node = workflow.nodes.length === 1 && isBespokeNode(workflow.nodes[0]) ? workflow.nodes[0] : null
  const triggers = workflow.meta.triggers ?? []
  const schedule = triggers.find(trigger => trigger.type === 'cron' && trigger.schedule)
  const hasVerificationStop = tier === 'loop' && hasExplicitLoopStop(workflow)

  if (!node) {
    return (
      <div className="skill-build-mode skill-build-mode--invalid">
        <div className="skill-build-mode__invalid" role="alert">
          <h2>This skill needs repair</h2>
          <p>A skill artifact must contain exactly one editable step and no connections. Export stays disabled until its structure is repaired.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="skill-build-mode">
      <main className="skill-build-mode__editor">
        <div className="skill-build-mode__editor-head">
          <div>
            <span className="skill-build-mode__eyebrow">Claude Code skill</span>
            <h2>Instructions</h2>
            <p>Edit the exact Markdown Claude will follow when this skill runs.</p>
          </div>
          <ArtifactBadge tier={tier} />
        </div>

        <label className="skill-build-mode__body-field">
          <span>SKILL.md body</span>
          <textarea
            value={node.agent.systemPrompt ?? ''}
            onChange={(event) => dispatch({ type: 'UPDATE_SKILL', payload: { body: event.target.value } })}
            placeholder="# What this skill does\n\n## Steps\n\n1. …"
            spellCheck
            aria-describedby="skill-body-hint"
          />
        </label>
        <p id="skill-body-hint" className="skill-build-mode__hint">
          Frontmatter is generated from the name and description above. Keep steps concrete and include a clear stopping condition.
        </p>
      </main>

      <aside className="skill-build-mode__rail" aria-label="Skill run settings">
        <section className="skill-build-mode__panel">
          <div className="skill-build-mode__panel-head">
            <h3>{tier === 'loop' ? 'Loop' : 'Run mode'}</h3>
            <ArtifactBadge tier={tier} />
          </div>
          {schedule?.schedule && (
            <>
              <p className="skill-build-mode__summary">{describeCron(schedule.schedule)}</p>
              <p className="skill-build-mode__status">
                <span aria-hidden="true" />
                {schedule.enabled ? 'Enabled in Automate' : 'Generated off by default'}
              </p>
              <code className="skill-build-mode__code">{schedule.schedule}</code>
            </>
          )}
          {hasVerificationStop && workflow.meta.sourceAutomation?.verificationCommand ? (
            <>
              <p className="skill-build-mode__summary">Repeats until verification passes or progress stops.</p>
              <code className="skill-build-mode__code">{workflow.meta.sourceAutomation.verificationCommand}</code>
            </>
          ) : hasVerificationStop && workflow.meta.sourceAutomation?.verificationStep ? (
            <>
              <p className="skill-build-mode__summary">Repeats the observed check until it passes or progress stops.</p>
              <p className="skill-build-mode__code">{workflow.meta.sourceAutomation.verificationStep}</p>
            </>
          ) : !schedule?.schedule ? (
            <p className="skill-build-mode__summary">Runs on demand. Add a schedule or webhook when this procedure should recur.</p>
          ) : null}
          <button type="button" className="skill-build-mode__secondary" onClick={() => navigate(`/w/${workflowId}/automate`)}>
            {triggers.length > 0 ? 'Edit automation' : 'Add automation'}
          </button>
        </section>

        <section className="skill-build-mode__panel skill-build-mode__panel--graduate">
          <h3>Need multiple roles?</h3>
          <p>Open this procedure on the canvas when separate agents, parallel work, or an approval gate would make it safer.</p>
          <button type="button" className="skill-build-mode__secondary" onClick={onGraduate}>Open as workflow</button>
        </section>
      </aside>
    </div>
  )
}
