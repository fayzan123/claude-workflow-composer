// src/detection/doctor.ts
//
// `cwc doctor`: offline health check for the Detect pipeline. Runs discovery and
// parsing over the local transcripts plus environment probes — never invokes
// Claude, so it costs nothing and works on machines where analysis itself is
// what's broken. Produces the same redacted ScanDiagnostics bundle the server
// records, suitable for pasting into a bug report.
import * as fs from 'node:fs/promises'
import { discoverTranscripts, parseSessionDetailed } from './transcript-parser.js'
import { envSnapshot, totalsOf, type ClaudeProbe, type FileParseStats, type ScanDiagnostics } from './scan-diagnostics.js'

export interface DoctorOptions {
  homeDir: string
  cwcVersion: string
  out: (line: string) => void
  claudeProbe?: ClaudeProbe
  bundlePath?: string          // when set, write the ScanDiagnostics JSON here
}

export async function runDoctor(opts: DoctorOptions): Promise<{ ok: boolean; bundle: ScanDiagnostics }> {
  const env = await envSnapshot(opts.cwcVersion, opts.claudeProbe)
  const { files, stats: discovery } = await discoverTranscripts(opts.homeDir)
  const fileStats: FileParseStats[] = []
  for (const f of files) fileStats.push((await parseSessionDetailed(f, opts.homeDir)).stats)
  const totals = totalsOf(fileStats)
  const bundle: ScanDiagnostics = { generatedAt: new Date().toISOString(), env, discovery, files: fileStats, totals }

  const problems: string[] = []
  if (!env.claude.found) problems.push('claude binary not found on PATH (Detect analysis needs it)')
  if (!discovery.rootExists) problems.push(`projects root not found at ${discovery.root} — has Claude Code run on this machine?`)
  else if (discovery.transcriptFiles === 0) problems.push('no transcript files found under the projects root')
  else if (totals.filesWithReadErrors === totals.files) problems.push('every transcript file failed to read')
  else if (totals.units === 0) problems.push('transcripts were found but no task units parsed — likely a transcript format change')

  const { out } = opts
  out(`cwc doctor — cwc ${env.cwcVersion}, ${env.platform}/${env.arch}, node ${env.nodeVersion}`)
  out(env.claude.found ? `claude binary: ${env.claude.version}` : `claude binary: NOT FOUND (${env.claude.error ?? 'unknown error'})`)
  out(discovery.rootExists
    ? `discovery: ${discovery.transcriptFiles} transcript file(s) across ${discovery.projectDirs} project dir(s)${discovery.unreadableDirs ? `, ${discovery.unreadableDirs} unreadable entr${discovery.unreadableDirs === 1 ? 'y' : 'ies'}` : ''}`
    : `discovery: projects root missing (${discovery.root})`)
  out(`parse: ${totals.units} task unit(s) from ${totals.files} file(s); ${totals.jsonErrors} unparseable line(s); ${totals.filesWithReadErrors} read failure(s)`)
  for (const f of fileStats) {
    if (f.readError) out(`  ! ${f.file}: read failed — ${f.readError}`)
    else if (f.jsonErrors > 0) out(`  ! ${f.file}: ${f.jsonErrors} unparseable line(s) of ${f.lines}`)
  }
  const ok = problems.length === 0
  if (ok) out('verdict: OK — Detect should work on this machine')
  else {
    out('verdict: PROBLEMS FOUND')
    for (const p of problems) out(`  - ${p}`)
  }
  if (opts.bundlePath) {
    await fs.writeFile(opts.bundlePath, JSON.stringify(bundle, null, 2))
    out(`diagnostic bundle written to ${opts.bundlePath} (redacted — safe to attach to a bug report)`)
  }
  return { ok, bundle }
}
