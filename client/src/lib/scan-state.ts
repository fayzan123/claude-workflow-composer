export const STRONG_AUTOMATION_CONFIDENCE = 0.6

export type ScanStateKind =
  | 'initial'
  | 'running'
  | 'results'
  | 'low-confidence'
  | 'empty'
  | 'error'

export interface ScanCandidateSummary {
  confidence: number
}

export interface ScanUiState {
  kind: ScanStateKind
  candidateCount: number
  strongCandidateCount: number
}

/**
 * Classify persisted scan data once so Home and Detect describe the same result.
 * Unknown statuses are treated as initial rather than presenting stale results as current.
 */
export function deriveScanUiState(status: string, candidates: ScanCandidateSummary[]): ScanUiState {
  const candidateCount = candidates.length
  const strongCandidateCount = candidates.filter(
    candidate => candidate.confidence >= STRONG_AUTOMATION_CONFIDENCE,
  ).length

  if (status === 'running') return { kind: 'running', candidateCount, strongCandidateCount }
  if (status === 'error') return { kind: 'error', candidateCount, strongCandidateCount }
  if (status !== 'done') return { kind: 'initial', candidateCount, strongCandidateCount }
  if (candidateCount === 0) return { kind: 'empty', candidateCount, strongCandidateCount }
  if (strongCandidateCount === 0) return { kind: 'low-confidence', candidateCount, strongCandidateCount }
  return { kind: 'results', candidateCount, strongCandidateCount }
}

export interface HomeScanAction {
  kind: 'view' | 'start'
  label: string
}

export function homeScanActionPath(kind: HomeScanAction['kind']): string {
  return kind === 'view' ? '/detect' : '/detect?autostart=1'
}

export interface HomeScanContent {
  title: string
  description?: string
  primary: HomeScanAction
  secondary?: HomeScanAction
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

export function homeScanContent(state: ScanUiState): HomeScanContent {
  switch (state.kind) {
    case 'running':
      return {
        title: 'Scanning your Claude Code history',
        description: 'Open the active scan to follow its progress and review the live scan log.',
        primary: { kind: 'view', label: 'View active scan' },
      }
    case 'results':
      return {
        title: `We found ${state.strongCandidateCount} ${plural(state.strongCandidateCount, 'thing')} you keep doing by hand`,
        primary: { kind: 'view', label: 'Review automations' },
        secondary: { kind: 'start', label: 'Scan again' },
      }
    case 'low-confidence':
      return {
        title: `${state.candidateCount} potential ${plural(state.candidateCount, 'pattern')} ${state.candidateCount === 1 ? 'needs' : 'need'} review`,
        description: 'CWC found repeated work, but the evidence is not strong enough to recommend it automatically.',
        primary: { kind: 'view', label: 'Review latest scan' },
        secondary: { kind: 'start', label: 'Scan again' },
      }
    case 'empty':
      return {
        title: 'No strong patterns yet',
        description: 'The scan completed without enough repeated evidence to recommend an automation.',
        primary: { kind: 'view', label: 'View latest scan' },
        secondary: { kind: 'start', label: 'Scan again' },
      }
    case 'error':
      return {
        title: 'The latest history scan did not finish',
        description: 'Open the scan to review the failure and its diagnostic log before trying again.',
        primary: { kind: 'view', label: 'Review failed scan' },
        secondary: { kind: 'start', label: 'Try again' },
      }
    case 'initial':
      return {
        title: 'Find the work you keep repeating in Claude Code',
        description: 'CWC scans your Claude Code history, spots the tasks you repeat, and compiles each one into the smallest useful automation.',
        primary: { kind: 'start', label: 'Scan my history' },
      }
  }
}

export interface DetectResultsContent {
  title: string
  detail?: string
  emptyTitle?: string
  emptyDescription?: string
}

export function detectResultsContent(state: ScanUiState): DetectResultsContent {
  switch (state.kind) {
    case 'running':
      return {
        title: 'Automation candidates',
        detail: 'Reading history and clustering repeat work',
        emptyTitle: 'Looking for repeatable work',
        emptyDescription: 'Candidates will appear here as soon as the scan finishes.',
      }
    case 'results':
      return {
        title: `${state.candidateCount} ${plural(state.candidateCount, 'automation')} found`,
      }
    case 'low-confidence':
      return {
        title: `${state.candidateCount} potential ${plural(state.candidateCount, 'pattern')} found`,
        detail: 'These results have weaker evidence. Review them before generating an artifact.',
      }
    case 'empty':
      return {
        title: 'Automation candidates',
        emptyTitle: 'No strong patterns found',
        emptyDescription: 'The scan completed without enough repeated evidence to suggest an automation. Try again after a few more Claude Code sessions.',
      }
    case 'error':
      return {
        title: 'Automation candidates',
        emptyTitle: 'History scan failed',
        emptyDescription: 'Review the scan log for the failing step, then run the scan again.',
      }
    case 'initial':
      return {
        title: 'Automation candidates',
        emptyTitle: 'Start with a history scan',
        emptyDescription: 'CWC will inspect your local Claude Code history, cluster repeated work, and recommend the right-sized artifacts worth generating.',
      }
  }
}
