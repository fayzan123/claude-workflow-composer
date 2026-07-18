import { useEffect, useState } from 'react'
import type { DetectedAutomation } from '../../../../src/detection/types.ts'
import type { ArtifactTier } from '../../lib/artifact.ts'
import type { RuleTarget } from '../../lib/api.ts'
import { artifactTierLabel } from '../../lib/artifact.ts'
import { isAbsolutePath } from '../../lib/path.ts'
import { ArtifactBadge } from '../common/ArtifactBadge.tsx'
import { Modal } from '../common/Modal.tsx'
import './PromotionDialog.css'

const OPTIONS: Array<{ tier: ArtifactTier; title: string; detail: string }> = [
  { tier: 'rule', title: 'Rule', detail: 'A durable instruction added to CLAUDE.md or AGENTS.md.' },
  { tier: 'skill', title: 'Skill', detail: 'One readable Claude Code skill, with no agent dispatch overhead.' },
  { tier: 'loop', title: 'Loop', detail: 'A skill with recurrence or an explicit verify-and-stop condition.' },
  { tier: 'workflow', title: 'Workflow', detail: 'A multi-agent canvas for parallel roles, handoffs, and gates.' },
]

interface Props {
  automation: DetectedAutomation | null
  busy?: boolean
  onClose: () => void
  onConfirm: (tier: ArtifactTier, target?: RuleTarget) => void
}

export function PromotionDialog({ automation, busy = false, onClose, onConfirm }: Props) {
  const recommended = automation?.recommendedTier ?? 'workflow'
  const evidenceProjects = automation?.evidence.repos.filter(isAbsolutePath) ?? []
  const [selected, setSelected] = useState<ArtifactTier>(recommended)
  const [ruleScope, setRuleScope] = useState<'user-claude' | 'project-agents'>('user-claude')
  const [projectDir, setProjectDir] = useState('')

  useEffect(() => {
    if (!automation) return
    setSelected(automation.recommendedTier ?? 'workflow')
    setRuleScope('user-claude')
    const remembered = localStorage.getItem('cwc:lastProjectDir') ?? ''
    setProjectDir(automation.evidence.repos.includes(remembered)
      ? remembered
      : automation.evidence.repos.find(isAbsolutePath) ?? '')
  }, [automation?.id, automation?.recommendedTier])

  if (!automation) return null

  const projectValid = evidenceProjects.includes(projectDir.trim())
  const groundedRuleAvailable = Boolean(automation.ruleSuggestion?.trim())
  const confirmDisabled = busy || (selected === 'rule' && (
    !groundedRuleAvailable || (ruleScope === 'project-agents' && !projectValid)
  ))

  function confirm() {
    if (confirmDisabled) return
    if (selected !== 'rule') {
      onConfirm(selected)
      return
    }
    const target: RuleTarget = ruleScope === 'user-claude'
      ? { type: 'user-claude' }
      : { type: 'project-agents', projectDir: projectDir.trim() }
    if (target.type === 'project-agents') localStorage.setItem('cwc:lastProjectDir', target.projectDir)
    onConfirm(selected, target)
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Generate “${automation.title}”`}>
      <div className="promotion-dialog">
        <p className="promotion-dialog__intro">
          CWC recommends the smallest artifact that captures this repetition. You can override it before anything is generated.
        </p>
        {automation.recommendedTierReason && (
          <p className="promotion-dialog__reason">
            Why this recommendation: {automation.recommendedTierReason}
          </p>
        )}

        <fieldset className="promotion-dialog__tiers">
          <legend>Generate as</legend>
          {OPTIONS.map((option) => {
            const isRecommended = option.tier === recommended
            return (
              <label key={option.tier} className={`promotion-dialog__tier${selected === option.tier ? ' promotion-dialog__tier--selected' : ''}`}>
                <input
                  type="radio"
                  name="artifact-tier"
                  value={option.tier}
                  checked={selected === option.tier}
                  onChange={() => setSelected(option.tier)}
                  disabled={busy}
                />
                <span className="promotion-dialog__tier-copy">
                  <span className="promotion-dialog__tier-title">
                    {option.title}
                    {isRecommended && <ArtifactBadge tier={option.tier} recommended />}
                  </span>
                  <span className="promotion-dialog__tier-detail">{option.detail}</span>
                </span>
              </label>
            )
          })}
        </fieldset>

        {selected === 'rule' && (
          <section className="promotion-dialog__rule" aria-labelledby="rule-target-heading">
            <h3 id="rule-target-heading">Add the rule to</h3>
            {groundedRuleAvailable && (
              <div className="promotion-dialog__suggestion">
                <span>Suggested instruction</span>
                <p>{automation.ruleSuggestion!.trim()}</p>
              </div>
            )}
            {!groundedRuleAvailable && (
              <div className="promotion-dialog__suggestion promotion-dialog__suggestion--missing" role="alert">
                <span>Grounded instruction unavailable</span>
                <p>Run a new history scan before adding this legacy detection as a standing rule.</p>
              </div>
            )}
            <div className="promotion-dialog__targets" role="radiogroup" aria-label="Rule target file">
              <label>
                <input
                  type="radio"
                  name="rule-target"
                  checked={ruleScope === 'user-claude'}
                  onChange={() => setRuleScope('user-claude')}
                  disabled={busy}
                />
                <span><strong>User CLAUDE.md</strong><small>Applies across your Claude Code projects.</small></span>
              </label>
              <label>
                <input
                  type="radio"
                  name="rule-target"
                  checked={ruleScope === 'project-agents'}
                  onChange={() => setRuleScope('project-agents')}
                  disabled={busy || evidenceProjects.length === 0}
                />
                <span>
                  <strong>Project AGENTS.md</strong>
                  <small>{evidenceProjects.length > 0 ? 'Applies only in one evidence project.' : 'No local evidence project is available.'}</small>
                </span>
              </label>
            </div>
            {ruleScope === 'project-agents' && (
              <label className="promotion-dialog__project">
                <span>Evidence project</span>
                <select
                  value={projectDir}
                  onChange={(event) => setProjectDir(event.target.value)}
                  aria-invalid={projectDir.length > 0 && !projectValid}
                  disabled={busy}
                >
                  {evidenceProjects.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
                </select>
                {!projectValid && <small role="alert">Choose one of the projects where CWC observed this repetition.</small>}
              </label>
            )}
          </section>
        )}

        <div className="promotion-dialog__actions">
          <button type="button" className="promotion-dialog__cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="promotion-dialog__confirm" onClick={confirm} disabled={confirmDisabled}>
            {busy ? 'Starting…' : selected === 'rule' ? 'Add rule' : `Generate ${artifactTierLabel(selected)}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
