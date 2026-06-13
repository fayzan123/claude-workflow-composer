import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { useRunEvents } from '../hooks/useRunEvents.ts'

export interface ModeProps {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  runState: ReturnType<typeof useRunEvents>
  workflowSlug: string
  workflowPath: string
}
