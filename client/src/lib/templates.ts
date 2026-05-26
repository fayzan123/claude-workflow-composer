import type { CwcFile, CwcNode, CwcEdge } from '../types.ts'
import { computeLayout } from './layout.ts'
import { v4 as uuidv4 } from 'uuid'

export interface TemplateDefinition {
  slug: string
  name: string
  description: string
  pattern: string
  nodes: Omit<CwcNode, 'position'>[]
  edges: CwcEdge[]
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    slug: 'full-feature-pipeline',
    name: 'Full Feature Pipeline',
    description: 'Design → acceptance tests → implement → quality loop → final verification. The complete TDD-gated feature workflow.',
    pattern: 'A → B → C → D → E → F (with quality loop)',
    nodes: [
      { id: 'node-1', exportedSlug: null, startTrigger: 'to produce the technical design for the feature', agent: { name: 'Technical Designer', description: 'Gate-based design: scope → options → detailed design → docs/design/<feature>-design.md', completionCriteria: 'Design document written to docs/design/<feature>-design.md with sections: Overview, Data Model, API/Interface, Implementation Steps, Testing Strategy, Risks & Mitigations.', tools: ['Read', 'Write', 'WebSearch'], skills: ['documentation-criteria', 'ai-development-guide'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-2', exportedSlug: null, agent: { name: 'Acceptance Test Generator', description: 'Writes failing black-box acceptance tests from the design doc before any implementation', completionCriteria: 'Failing acceptance tests written to tests/acceptance/<feature>.test.ts. All tests currently fail.', tools: ['Read', 'Write', 'Bash'], skills: ['testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-3', exportedSlug: null, agent: { name: 'Task Decomposer', description: 'Breaks the design into atomic task files in docs/plans/tasks/ with a MANIFEST.md execution order', completionCriteria: 'Atomic task files written to docs/plans/tasks/. MANIFEST.md lists execution order.', tools: ['Read', 'Write'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-4', exportedSlug: null, agent: { name: 'Task Executor', description: 'Implements one task file: write failing test → implement → full suite passes. Outputs JSON status.', completionCriteria: 'Output JSON: {"status":"completed"|"escalation_needed","filesModified":[...],"testsAdded":[...],"requiresTestReview":false,"escalationReason":null}', tools: ['Read', 'Write', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-5', exportedSlug: null, agent: { name: 'Quality Fixer', description: 'Runs lint + build + full test suite. Fixes every failure at root cause. Outputs JSON approval status.', completionCriteria: 'Output JSON: {"status":"approved"|"blocked"|"stub_detected","lintErrors":0,"buildErrors":0,"testsFailing":0,"stubsFound":[],"blockerReason":null}. Status must be "approved".', tools: ['Read', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-6', exportedSlug: null, agent: { name: 'Code Verifier', description: 'Final gate: runs acceptance tests, verifies design doc compliance, confirms no stubs remain', completionCriteria: 'Output JSON: {"allAcceptanceTestsPass":true,"designDocCompliant":true,"noStubsRemaining":true,"deviations":[]}. All fields must be true.', tools: ['Read', 'Bash'], model: 'inherit', systemPrompt: '' } },
    ],
    edges: [
      { id: 'edge-1', from: 'node-1', to: 'node-2', trigger: 'When the design document is complete and written to docs/design/<feature>-design.md, activate Acceptance Test Generator.', context: [{ name: 'Design Document', type: 'file', path: 'docs/design/<feature>-design.md' }] },
      { id: 'edge-2', from: 'node-2', to: 'node-3', trigger: 'When acceptance tests are written and currently failing, activate Task Decomposer to break the design into task files.', context: [{ name: 'Design Document', type: 'file', path: 'docs/design/<feature>-design.md' }] },
      { id: 'edge-3', from: 'node-3', to: 'node-4', trigger: 'When task files are written and MANIFEST.md is complete, activate Task Executor for the first task in the manifest.', context: [{ name: 'Task Manifest', type: 'file', path: 'docs/plans/tasks/MANIFEST.md' }] },
      { id: 'edge-4', from: 'node-4', to: 'node-5', trigger: 'When Task Executor outputs {"status":"completed",...}, activate Quality Fixer.', context: [{ name: 'Task Executor Output', type: 'json' }] },
      { id: 'edge-5', from: 'node-5', to: 'node-4', trigger: 'If Quality Fixer outputs {"status":"approved"} and more tasks remain in MANIFEST.md, return to Task Executor for the next task.', context: [{ name: 'Quality Fixer Output', type: 'json' }] },
      { id: 'edge-6', from: 'node-5', to: 'node-6', trigger: 'If Quality Fixer outputs {"status":"approved"} and all tasks in MANIFEST.md are complete, activate Code Verifier for final acceptance check.', context: [{ name: 'Quality Fixer Output', type: 'json' }] },
      { id: 'edge-7', from: 'node-6', to: null, trigger: 'When Code Verifier outputs all fields true, the workflow is complete.', terminalType: 'complete', context: [] },
    ],
  },
  {
    slug: 'bug-fix-cycle',
    name: 'Bug Fix Cycle',
    description: "Investigate → Devil's Advocate verification → targeted fix → quality gate. Prevents fixing the wrong thing.",
    pattern: 'A → B → C → D',
    nodes: [
      { id: 'node-1', exportedSlug: null, startTrigger: 'to investigate the bug and map its failure points', agent: { name: 'Bug Investigator', description: 'Reproduces bug, traces execution to root cause, outputs structured JSON: pathMap, failurePoints, impactAnalysis', completionCriteria: 'Output JSON: {"reproduced":true,"pathMap":[...],"failurePoints":[{"file":"...","line":0,"reason":"..."}],"impactAnalysis":"...","suggestedFixArea":"..."}', tools: ['Read', 'Bash'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-2', exportedSlug: null, agent: { name: 'Investigation Verifier', description: "Devil's Advocate: challenges root-cause assumptions, finds counter-evidence, confirms or revises failure points", completionCriteria: 'Output JSON: {"verdict":"confirmed"|"revised"|"rejected","confirmedFailurePoints":[...],"alternativeTheories":[...],"recommendedFix":"..."}', tools: ['Read', 'Bash'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-3', exportedSlug: null, agent: { name: 'Bug Solver', description: 'Minimal targeted fix at confirmed failure points + regression test that would have caught the bug', completionCriteria: 'Fix implemented at confirmedFailurePoints only. Regression test added. All tests pass. Lint clean.', tools: ['Read', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-4', exportedSlug: null, agent: { name: 'Quality Fixer', description: 'Runs lint + build + full test suite. Fixes every failure at root cause. Outputs JSON approval status.', completionCriteria: 'Output JSON: {"status":"approved","lintErrors":0,"buildErrors":0,"testsFailing":0,"stubsFound":[],"blockerReason":null}', tools: ['Read', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
    ],
    edges: [
      { id: 'edge-1', from: 'node-1', to: 'node-2', trigger: 'When Bug Investigator outputs its JSON with failurePoints, activate Investigation Verifier to challenge the conclusions.', context: [{ name: 'Investigation JSON', type: 'json' }] },
      { id: 'edge-2', from: 'node-2', to: 'node-3', trigger: 'When Investigation Verifier outputs verdict "confirmed" or "revised", activate Bug Solver with the confirmedFailurePoints.', context: [{ name: 'Verified Investigation JSON', type: 'json' }] },
      { id: 'edge-3', from: 'node-3', to: 'node-4', trigger: 'When Bug Solver has implemented the fix and added the regression test, activate Quality Fixer.', context: [] },
      { id: 'edge-4', from: 'node-4', to: null, trigger: 'When Quality Fixer outputs {"status":"approved"}, the workflow is complete.', terminalType: 'complete', context: [] },
    ],
  },
  {
    slug: 'review-gated-build',
    name: 'Review-Gated Build',
    description: 'Implement → quality check → code review with auto-fix loop. Builds on existing task files.',
    pattern: 'A → B → C → loop or complete',
    nodes: [
      { id: 'node-1', exportedSlug: null, startTrigger: 'to implement the task file at the given path', agent: { name: 'Task Executor', description: 'TDD implementation of one task file. Write failing test → implement → full suite passes. Outputs JSON status.', completionCriteria: 'Output JSON: {"status":"completed","filesModified":[...],"testsAdded":[...],"requiresTestReview":false,"escalationReason":null}', tools: ['Read', 'Write', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-2', exportedSlug: null, agent: { name: 'Quality Fixer', description: 'Runs lint + build + full suite. Fixes every failure at root cause. Never suppresses errors.', completionCriteria: 'Output JSON: {"status":"approved","lintErrors":0,"buildErrors":0,"testsFailing":0,"stubsFound":[],"blockerReason":null}', tools: ['Read', 'Edit', 'Bash'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-3', exportedSlug: null, agent: { name: 'Code Reviewer', description: 'Reviews against design doc: compliance rate, acceptance criteria pass/fail, quality findings. Outputs JSON verdict.', completionCriteria: 'Output JSON: {"complianceRate":0.95,"verdict":"approved"|"changes_required"|"blocked","acceptanceCriteria":[...],"qualityFindings":[...]}', tools: ['Read'], skills: ['coding-principles', 'testing-principles'], model: 'inherit', systemPrompt: '' } },
    ],
    edges: [
      { id: 'edge-1', from: 'node-1', to: 'node-2', trigger: 'When Task Executor outputs {"status":"completed",...}, activate Quality Fixer.', context: [{ name: 'Task Executor Output', type: 'json' }] },
      { id: 'edge-2', from: 'node-2', to: 'node-3', trigger: 'When Quality Fixer outputs {"status":"approved"}, activate Code Reviewer.', context: [{ name: 'Quality Fixer Output', type: 'json' }] },
      { id: 'edge-3', from: 'node-3', to: null, trigger: 'When Code Reviewer outputs {"verdict":"approved",...}, the workflow is complete.', terminalType: 'complete', context: [] },
      { id: 'edge-4', from: 'node-3', to: 'node-1', trigger: 'When Code Reviewer outputs {"verdict":"changes_required",...}, return to Task Executor with the qualityFindings to address.', context: [{ name: 'Code Review JSON', type: 'json' }] },
    ],
  },
  {
    slug: 'design-to-docs',
    name: 'Design to Docs',
    description: 'Research → technical design → document review gate. Produces a reviewed design doc before any code is written.',
    pattern: 'A → B → C → loop or complete',
    nodes: [
      { id: 'node-1', exportedSlug: null, startTrigger: 'to research the problem space and synthesize a recommendation', agent: { name: 'Research Synthesizer', description: 'Gathers sources, compares 2-3 approaches with trade-off analysis, produces unhedged recommendation to docs/research/<topic>-synthesis.md', completionCriteria: 'Research synthesis written to docs/research/<topic>-synthesis.md with comparison of at least 2 approaches and a clear, unhedged recommendation.', tools: ['WebSearch', 'WebFetch', 'Write'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-2', exportedSlug: null, agent: { name: 'Technical Designer', description: 'Gate-based design: scope → options → detailed design → docs/design/<feature>-design.md', completionCriteria: 'Design document written to docs/design/<feature>-design.md with all required sections: Overview, Data Model, API/Interface, Implementation Steps, Testing Strategy, Risks & Mitigations.', tools: ['Read', 'Write', 'WebSearch'], skills: ['documentation-criteria', 'ai-development-guide'], model: 'inherit', systemPrompt: '' } },
      { id: 'node-3', exportedSlug: null, agent: { name: 'Document Reviewer', description: 'Reviews the design doc for completeness, accuracy, clarity, and actionability — outputs APPROVED or NEEDS REVISION', completionCriteria: 'Document review written with specific feedback on Completeness, Accuracy, Clarity, and Actionability. Clear APPROVED or NEEDS REVISION verdict.', tools: ['Read'], skills: ['documentation-criteria'], model: 'inherit', systemPrompt: '' } },
    ],
    edges: [
      { id: 'edge-1', from: 'node-1', to: 'node-2', trigger: 'When research synthesis is complete, activate Technical Designer to produce the design document.', context: [{ name: 'Research Synthesis', type: 'file', path: 'docs/research/<topic>-synthesis.md' }] },
      { id: 'edge-2', from: 'node-2', to: 'node-3', trigger: 'When the design document is complete, activate Document Reviewer.', context: [{ name: 'Design Document', type: 'file', path: 'docs/design/<feature>-design.md' }] },
      { id: 'edge-3', from: 'node-3', to: null, trigger: 'When Document Reviewer outputs APPROVED, the workflow is complete.', terminalType: 'complete', context: [] },
      { id: 'edge-4', from: 'node-3', to: 'node-2', trigger: 'When Document Reviewer outputs NEEDS REVISION, return to Technical Designer with the specific review feedback.', context: [{ name: 'Document Review Feedback', type: 'text' }] },
    ],
  },
]

export function instantiateTemplate(template: TemplateDefinition): CwcFile {
  const positions = computeLayout(
    template.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })),
    template.edges
  )
  const nodes: CwcNode[] = template.nodes.map((n) => ({
    ...n,
    position: positions.get(n.id) ?? { x: 0, y: 0 },
  }))
  return {
    meta: {
      id: uuidv4(),
      name: template.name,
      description: template.description,
      version: 1,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    },
    nodes,
    edges: template.edges,
  }
}
