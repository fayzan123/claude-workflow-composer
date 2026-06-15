// src/detection/transcript-parser.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { TaskUnit } from './types.js'

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

/** Parse one session .jsonl into task units (one per user prompt). */
export async function parseSession(filePath: string): Promise<TaskUnit[]> {
  let raw: string
  try { raw = await fs.readFile(filePath, 'utf-8') } catch { return [] }
  const units: TaskUnit[] = []
  let cur: TaskUnit | null = null
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue
    let o: RawLine
    try { o = JSON.parse(ln) } catch { continue }
    if (isUserPrompt(o)) {
      if (cur) units.push(cur)
      cur = {
        sessionId: o.sessionId ?? '', cwd: o.cwd ?? '', gitBranch: o.gitBranch,
        startedAt: o.timestamp ?? '', endedAt: o.timestamp ?? '', tools: [], commands: [],
      }
      continue
    }
    if (!cur) continue
    const tus = toolUseBlocks(o)
    if (tus.length > 0) {
      if (o.timestamp) cur.endedAt = o.timestamp
      for (const t of tus) {
        cur.tools.push(t.name)
        if (t.name === 'Bash' && typeof t.input?.command === 'string') cur.commands.push(t.input.command as string)
      }
    }
  }
  if (cur) units.push(cur)
  return units
}

/** All session transcript files under ~/.claude/projects/<encoded>/*.jsonl. */
export async function findTranscripts(homeDir = os.homedir()): Promise<string[]> {
  const root = path.join(homeDir, '.claude', 'projects')
  let projects: string[] = []
  try { projects = await fs.readdir(root) } catch { return [] }
  const out: string[] = []
  for (const proj of projects) {
    let files: string[] = []
    try { files = await fs.readdir(path.join(root, proj)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(root, proj, f))
  }
  return out
}
