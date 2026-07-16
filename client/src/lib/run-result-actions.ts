export type RunResultActionKind = 'apply' | 'discard'

export interface RunResultActionState {
  confirmingDiscard: boolean
  pending: RunResultActionKind | null
  completed: RunResultActionKind | null
  error: string | null
}

export type RunResultActionEvent =
  | { type: 'request_discard' }
  | { type: 'cancel_discard' }
  | { type: 'start'; action: RunResultActionKind }
  | { type: 'succeed'; action: RunResultActionKind }
  | { type: 'fail'; message: string }
  | { type: 'reset' }

export const INITIAL_RUN_RESULT_ACTION_STATE: RunResultActionState = {
  confirmingDiscard: false,
  pending: null,
  completed: null,
  error: null,
}

export function runResultActionReducer(state: RunResultActionState, event: RunResultActionEvent): RunResultActionState {
  switch (event.type) {
    case 'request_discard':
      if (state.pending) return state
      return { ...state, confirmingDiscard: true, error: null }
    case 'cancel_discard':
      if (state.pending) return state
      return { ...state, confirmingDiscard: false }
    case 'start':
      if (state.pending) return state
      return { ...state, confirmingDiscard: false, pending: event.action, completed: null, error: null }
    case 'succeed':
      return { ...state, confirmingDiscard: false, pending: null, completed: event.action, error: null }
    case 'fail':
      return { ...state, confirmingDiscard: false, pending: null, completed: null, error: event.message }
    case 'reset':
      return INITIAL_RUN_RESULT_ACTION_STATE
  }
}
