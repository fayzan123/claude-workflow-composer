import type { CwcFile } from '../types.ts'

export interface ExportArtifactSnapshot {
  artifact: CwcFile
  serialized: string
}

/** Freeze the exact artifact the server previewed. Confirming an export must either use
 * this snapshot or ask for a new preview if the live editor state has changed. */
export function createExportArtifactSnapshot(cwc: CwcFile): ExportArtifactSnapshot {
  const serialized = JSON.stringify(cwc)
  return {
    artifact: JSON.parse(serialized) as CwcFile,
    serialized,
  }
}

export function matchesExportArtifactSnapshot(cwc: CwcFile, snapshot: ExportArtifactSnapshot): boolean {
  return JSON.stringify(cwc) === snapshot.serialized
}
