import type { ArtifactTier } from '../../lib/artifact.ts'
import { artifactTierLabel } from '../../lib/artifact.ts'
import './ArtifactBadge.css'

interface Props {
  tier: ArtifactTier
  recommended?: boolean
  className?: string
}

export function ArtifactBadge({ tier, recommended = false, className = '' }: Props) {
  return (
    <span className={`artifact-badge artifact-badge--${tier}${className ? ` ${className}` : ''}`}>
      {artifactTierLabel(tier)}
      {recommended && <span className="artifact-badge__recommended">recommended</span>}
    </span>
  )
}
