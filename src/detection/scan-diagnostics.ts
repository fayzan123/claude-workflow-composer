// src/detection/scan-diagnostics.ts
//
// Diagnostics model for the Detect pipeline. Everything here is designed to be
// safe to paste into a public bug report: counts, versions, JSON `type` values,
// and redacted error messages only. No field can carry prompt text, Bash
// commands, or transcript message content.
import { execFile } from 'node:child_process'

/** Per-transcript parse statistics. `file` is always a redacted (~-relative) path. */
export interface FileParseStats {
  file: string
  bytes: number
  lines: number                           // non-blank lines
  units: number                           // task units produced
  jsonErrors: number                      // lines that failed JSON.parse
  typeCounts: Record<string, number>      // top-level `type` values seen
  readError?: string                      // redacted message; file contributed nothing
}

export interface DiscoveryStats {
  root: string                            // redacted, e.g. "~/.claude/projects"
  rootExists: boolean
  projectDirs: number
  unreadableDirs: number
  transcriptFiles: number
}

export interface EnvSnapshot {
  platform: NodeJS.Platform
  arch: string
  nodeVersion: string
  cwcVersion: string
  claude: { found: boolean; version?: string; error?: string }
}

export type ScanStage = 'discovery' | 'parse' | 'digest' | 'analysis' | 'parse-response'

export interface ScanDiagnostics {
  generatedAt: string
  env: EnvSnapshot
  discovery: DiscoveryStats
  files: FileParseStats[]
  totals: {
    files: number
    filesWithReadErrors: number
    units: number
    jsonErrors: number
    typeCounts: Record<string, number>
  }
  failure?: { stage: ScanStage; message: string }
}

/** Replace every occurrence of the home dir (in either separator spelling) with `~`. */
export function redact(text: string, homeDir: string): string {
  if (!homeDir) return text
  let out = text.split(homeDir).join('~')
  const flipped = homeDir.includes('\\') ? homeDir.replaceAll('\\', '/') : homeDir.replaceAll('/', '\\')
  if (flipped !== homeDir) out = out.split(flipped).join('~')
  return out
}

export function totalsOf(files: FileParseStats[]): ScanDiagnostics['totals'] {
  const typeCounts: Record<string, number> = {}
  let units = 0
  let jsonErrors = 0
  let filesWithReadErrors = 0
  for (const f of files) {
    units += f.units
    jsonErrors += f.jsonErrors
    if (f.readError) filesWithReadErrors++
    for (const [t, n] of Object.entries(f.typeCounts)) typeCounts[t] = (typeCounts[t] ?? 0) + n
  }
  return { files: files.length, filesWithReadErrors, units, jsonErrors, typeCounts }
}

export type ClaudeProbe = () => Promise<{ version: string }>

const defaultProbe: ClaudeProbe = () =>
  new Promise((resolve, reject) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ version: stdout.trim() })
    })
  })

/** Snapshot the environment. Probe failures are recorded, never thrown. */
export async function envSnapshot(cwcVersion: string, probe: ClaudeProbe = defaultProbe): Promise<EnvSnapshot> {
  const base = { platform: process.platform, arch: process.arch, nodeVersion: process.version, cwcVersion }
  try {
    const { version } = await probe()
    return { ...base, claude: { found: true, version } }
  } catch (err) {
    return { ...base, claude: { found: false, error: err instanceof Error ? err.message : String(err) } }
  }
}
