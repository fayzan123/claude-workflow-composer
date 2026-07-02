// src/detection/transcript-parser.ts
import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import * as readline from 'node:readline'
import * as path from 'node:path'
import * as os from 'node:os'
import type { TaskUnit } from './types.js'
import { redact, type FileParseStats, type DiscoveryStats } from './scan-diagnostics.js'

interface RawLine {
  type?: string
  isMeta?: boolean
  cwd?: string
  gitBranch?: string
  timestamp?: string
  sessionId?: string
  promptId?: string
  message?: { role?: string; content?: unknown }
}

/** A line that starts a new task unit: a real user prompt (has a text block, not a tool_result, not meta). */
function isUserPrompt(o: RawLine): boolean {
  if (o.type !== 'user' || o.isMeta) return false
  const c = o.message?.content
  if (typeof c === 'string') return c.length > 0
  if (Array.isArray(c)) return c.some(b => (b as { type?: string }).type === 'text')
  return false
}

function toolUseBlocks(o: RawLine): { name: string; input?: Record<string, unknown> }[] {
  if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) return []
  return (o.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[])
    .filter(b => b.type === 'tool_use' && typeof b.name === 'string')
    .map(b => ({ name: b.name as string, input: b.input }))
}

/** Extract the user-visible prompt text from a user line, truncated to 280 chars. */
function promptTextOf(o: RawLine): string {
  const c = o.message?.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    const block = c.find(b => (b as { type?: string }).type === 'text') as { text?: string } | undefined
    text = block?.text ?? ''
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 280)
}

/**
 * Parse one session .jsonl into task units, streaming line-by-line, with per-file
 * statistics: nothing is skipped silently. Read failures are recorded on the stats
 * (never thrown); non-object or unparseable lines count as jsonErrors; every
 * top-level `type` value is tallied so schema drift is visible in diagnostics.
 */
export async function parseSessionDetailed(filePath: string, homeDir?: string): Promise<{ units: TaskUnit[]; stats: FileParseStats }> {
  const stats: FileParseStats = {
    file: homeDir ? redact(filePath, homeDir) : filePath,
    bytes: 0, lines: 0, units: 0, jsonErrors: 0, typeCounts: {},
  }
  const units: TaskUnit[] = []
  let cur: TaskUnit | null = null
  try {
    stats.bytes = (await fs.stat(filePath)).size
    const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity })
    for await (const ln of rl) {
      if (!ln.trim()) continue
      stats.lines++
      let parsed: unknown
      try { parsed = JSON.parse(ln) } catch { stats.jsonErrors++; continue }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { stats.jsonErrors++; continue }
      const o = parsed as RawLine
      const t = typeof o.type === 'string' && o.type ? o.type : '(none)'
      stats.typeCounts[t] = (stats.typeCounts[t] ?? 0) + 1
      if (isUserPrompt(o)) {
        if (cur) units.push(cur)
        cur = {
          sessionId: o.sessionId ?? '', cwd: o.cwd ?? '', gitBranch: o.gitBranch,
          promptText: promptTextOf(o),
          startedAt: o.timestamp ?? '', endedAt: o.timestamp ?? '', tools: [], commands: [],
        }
        continue
      }
      if (!cur) continue
      const tus = toolUseBlocks(o)
      if (tus.length > 0) {
        if (o.timestamp) cur.endedAt = o.timestamp
        for (const tu of tus) {
          cur.tools.push(tu.name)
          if (tu.name === 'Bash' && typeof tu.input?.command === 'string') cur.commands.push(tu.input.command as string)
        }
      }
    }
  } catch (err) {
    stats.readError = redact(err instanceof Error ? err.message : String(err), homeDir ?? '')
    return { units: [], stats }
  }
  if (cur) units.push(cur)
  stats.units = units.length
  return { units, stats }
}

/** Parse one session .jsonl into task units (one per user prompt). */
export async function parseSession(filePath: string): Promise<TaskUnit[]> {
  return (await parseSessionDetailed(filePath)).units
}

/**
 * All session transcript files under ~/.claude/projects/<encoded>/*.jsonl, with
 * discovery statistics: a missing root, and entries that cannot be read as
 * directories, are counted rather than silently collapsing into "no history".
 */
export async function discoverTranscripts(homeDir = os.homedir()): Promise<{ files: string[]; stats: DiscoveryStats }> {
  const root = path.join(homeDir, '.claude', 'projects')
  const stats: DiscoveryStats = {
    root: redact(root, homeDir),
    rootExists: false, projectDirs: 0, unreadableDirs: 0, transcriptFiles: 0,
  }
  let projects: string[] = []
  try { projects = await fs.readdir(root) } catch { return { files: [], stats } }
  stats.rootExists = true
  const out: string[] = []
  for (const proj of projects) {
    let files: string[] = []
    try { files = await fs.readdir(path.join(root, proj)) } catch { stats.unreadableDirs++; continue }
    stats.projectDirs++
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(root, proj, f))
  }
  stats.transcriptFiles = out.length
  return { files: out, stats }
}

/** All session transcript files under ~/.claude/projects/<encoded>/*.jsonl. */
export async function findTranscripts(homeDir = os.homedir()): Promise<string[]> {
  return (await discoverTranscripts(homeDir)).files
}
