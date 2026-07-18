import { Router as createRouter } from 'express'
import { ExportConflictError, InvalidArtifactError, exportWorkflow } from '../../export/exporter.js'
import type { ExportTarget, ExportOptions } from '../../export/exporter.js'
import type { CwcFile } from '../../schema.js'
import * as path from 'node:path'
import {
  isWorkflowRevision,
  readPersistedWorkflow,
  replaceWorkflowFileAtomically,
  serializedWorkflow,
  workflowRevision,
  WorkflowUpdateConflict,
  type WorkflowMutationCoordinator,
} from './workflows.js'

export interface ExportRouterOptions {
  mutations: WorkflowMutationCoordinator
  onSaved?: () => void | Promise<void>
}

function isFsError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as NodeJS.ErrnoException).code === code
}

export function exportRouter(config: ExportRouterOptions) {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target, skillsDir, workflowPath, expectedRevision } = req.body as {
      cwcFile: CwcFile
      target: ExportTarget
      skillsDir?: string
      workflowPath?: string
      expectedRevision?: string
    }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (typeof workflowPath !== 'string' || !isWorkflowRevision(expectedRevision)) {
      return void res.status(409).json({ error: 'Current workflow path and revision are required. Reload this recipe before exporting.' })
    }
    const resolvedWorkflowPath = config.mutations.resolveWorkflowPath(workflowPath)
    if (!resolvedWorkflowPath) {
      return void res.status(403).json({ error: 'Workflow path is outside the workflows directory.' })
    }
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) {
      return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    }
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) {
      return void res.status(400).json({ error: 'userDir must be an absolute path' })
    }
    if (skillsDir && !path.isAbsolute(skillsDir)) {
      return void res.status(400).json({ error: 'skillsDir must be an absolute path' })
    }

    const exportOpts: ExportOptions = { ...(skillsDir ? { skillsDir } : {}) }

    try {
      const result = await config.mutations.withPathLeases([resolvedWorkflowPath], async () => {
        const persisted = await readPersistedWorkflow(resolvedWorkflowPath, cwcFile.meta.id)
        if (persisted.revision !== expectedRevision) {
          throw new WorkflowUpdateConflict('Workflow changed in another editor. Reload before exporting again.')
        }
        if (workflowRevision(serializedWorkflow(cwcFile)) !== expectedRevision) {
          throw new WorkflowUpdateConflict('Export snapshot does not match the saved recipe. Save and preview it again before exporting.')
        }

        let recipeRevision = ''
        const exported = await exportWorkflow(cwcFile, target, {
          ...exportOpts,
          commitUpdatedCwc: async updatedCwc => {
            await replaceWorkflowFileAtomically(resolvedWorkflowPath, updatedCwc, persisted.mode, {
              expectedRevision: persisted.revision,
            })
            recipeRevision = workflowRevision(serializedWorkflow(updatedCwc))
          },
        })
        if (!recipeRevision) throw new Error('Export completed without persisting recipe authority.')
        try { await config.onSaved?.() } catch { /* deployment and recipe already committed */ }
        return { ...exported, recipeRevision }
      })
      res.json(result)
    } catch (err) {
      if (err instanceof ExportConflictError) {
        return void res.status(409).json({ error: err.message, path: err.filePath })
      }
      if (err instanceof InvalidArtifactError) {
        return void res.status(400).json({ error: err.message })
      }
      if (isFsError(err, 'ENOENT')) {
        return void res.status(404).json({ error: 'Workflow no longer exists. Reload before exporting again.' })
      }
      if (err instanceof WorkflowUpdateConflict) {
        return void res.status(409).json({ error: err.message })
      }
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
