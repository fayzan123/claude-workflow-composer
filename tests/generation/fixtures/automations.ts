import type { DetectedAutomation } from '../../../src/detection/types.js'
import type { WorkflowPlan } from '../../../src/generation/plan-schema.js'

export interface GenerationFixture {
  automation: DetectedAutomation
  plan: WorkflowPlan
}

function automation(id: string, title: string, description: string, steps: string[]): DetectedAutomation {
  return {
    id,
    title,
    description,
    steps,
    stepTokens: steps.map(step => step.toLowerCase().replace(/\s+/g, '-')),
    evidence: { count: 3, repos: ['/repo'], sessionIds: [], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: 'manual' },
    confidence: 0.9,
    status: 'new',
  }
}

export const lawFirm: GenerationFixture = {
  automation: automation('law-firm', 'Law Firm Microsite', 'Duplicate, research, rebrand, and deploy a prospect microsite.', [
    'duplicate the demo repo',
    'research the prospect firm online',
    'rebrand the copy and assets',
    'deploy to vercel',
  ]),
  plan: {
    name: 'Law Firm Microsite',
    description: 'Duplicate, research, rebrand, and deploy a prospect microsite.',
    phases: [
      { id: 'p1', intent: 'duplicate the demo repo', stepIndexes: [0], archetypeHint: 'prepare' },
      { id: 'p2', intent: 'research the prospect firm online', stepIndexes: [1], archetypeHint: 'research' },
      { id: 'p3', intent: 'rebrand the copy and assets', stepIndexes: [2], archetypeHint: 'implement' },
      { id: 'p4', intent: 'deploy to vercel', stepIndexes: [3], archetypeHint: 'publish' },
    ],
  },
}

export const npmRelease: GenerationFixture = {
  automation: automation('npm-release', 'NPM Release', 'Verify, version, and publish a package.', [
    'run the test suite',
    'typecheck',
    'bump the version',
    'npm publish',
  ]),
  plan: {
    name: 'NPM Release',
    description: 'Verify, version, and publish a package.',
    phases: [
      { id: 'p1', intent: 'verify the package', stepIndexes: [0, 1], archetypeHint: 'verify' },
      { id: 'p2', intent: 'bump the version', stepIndexes: [2], archetypeHint: 'prepare' },
      { id: 'p3', intent: 'publish to npm', stepIndexes: [3], archetypeHint: 'publish' },
    ],
  },
}

export const fullStack: GenerationFixture = {
  automation: automation('full-stack-feature', 'Full Stack Feature', 'Build, verify, and open review for a feature.', [
    'implement the API endpoint',
    'write the React component',
    'run tests',
    'open a pull request',
  ]),
  plan: {
    name: 'Full Stack Feature',
    description: 'Build, verify, and open review for a feature.',
    phases: [
      { id: 'p1', intent: 'implement the API endpoint', stepIndexes: [0], archetypeHint: 'implement' },
      { id: 'p2', intent: 'write the React component', stepIndexes: [1], archetypeHint: 'implement' },
      { id: 'p3', intent: 'run tests', stepIndexes: [2], archetypeHint: 'verify' },
      { id: 'p4', intent: 'open a pull request', stepIndexes: [3], archetypeHint: 'publish', riskHint: ['merge'] },
    ],
  },
}
