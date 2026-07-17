import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const RULE_ID = /^[a-zA-Z0-9_-]{1,128}$/
const fileQueues = new Map<string, Promise<void>>()

export type RuleFileChange = 'added' | 'already-present' | 'removed' | 'not-found'

export interface RuleFileWriteOptions {
  /** Test/embedding hook after the complete temp write and before the final
   * compare-and-rename guard. Never exposed by the HTTP route. */
  beforeAtomicRename?: (filePath: string, tempPath: string) => Promise<void>
}

export class RuleFileConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleFileConflictError'
  }
}

function markers(automationId: string): { open: string; close: string } {
  if (!RULE_ID.test(automationId)) throw new Error('invalid automation id for rule marker')
  return {
    open: `<!-- cwc:rule:${automationId} -->`,
    close: `<!-- /cwc:rule:${automationId} -->`,
  }
}

/** Keep an untrusted transcript-derived suggestion on one Markdown line and unable
 * to forge another CWC ownership marker. */
export function normalizeRuleSuggestion(value: string): string {
  const clean = value
    .replace(/\s+/g, ' ')
    .replace(/<!--\s*\/?cwc:/gi, '&lt;!-- cwc:')
    .trim()
    .slice(0, 1_000)
  if (!clean) throw new Error('rule suggestion is empty')
  return /[.!?`]$/.test(clean) ? clean : `${clean}.`
}

export function buildRuleBlock(automationId: string, suggestion: string): string {
  const { open, close } = markers(automationId)
  return `${open}\n${normalizeRuleSuggestion(suggestion)}\n${close}`
}

interface LocatedBlock {
  start: number
  end: number
}

/** Validate every CWC rule block before rewriting any user-owned guidance file.
 * A valid target block must not lend authority to overwrite a file containing a
 * malformed, orphaned, duplicated, or nested block belonging to another id. */
function validateRuleBlockGrammar(content: string): void {
  const openPattern = /^<!-- cwc:rule:([a-zA-Z0-9_-]{1,128}) -->$/
  const closePattern = /^<!-- \/cwc:rule:([a-zA-Z0-9_-]{1,128}) -->$/
  const seen = new Set<string>()
  let active: string | null = null

  for (const line of content.split('\n')) {
    const mentionsMarker = line.includes('<!-- cwc:rule:') || line.includes('<!-- /cwc:rule:')
    if (!mentionsMarker) continue
    const open = line.match(openPattern)
    const close = line.match(closePattern)
    if (!open && !close) throw new Error('rule ownership marker is malformed')
    if (open) {
      const id = open[1]
      if (active !== null) throw new Error('rule ownership markers cannot be nested')
      if (seen.has(id)) throw new Error('rule ownership marker is duplicated')
      active = id
      continue
    }
    const id = close![1]
    if (active === null) throw new Error('rule ownership marker has an orphaned close')
    if (active !== id) throw new Error('rule ownership markers are mismatched')
    seen.add(id)
    active = null
  }
  if (active !== null) throw new Error('rule ownership marker is malformed')
}

function locateRuleBlock(content: string, automationId: string): LocatedBlock | null {
  validateRuleBlockGrammar(content)
  const { open, close } = markers(automationId)
  const start = content.indexOf(open)
  const closeStart = content.indexOf(close)
  if (start < 0 && closeStart < 0) return null
  if (start < 0 || closeStart < start) throw new Error('rule ownership marker is malformed')
  if (content.indexOf(open, start + open.length) >= 0 || content.indexOf(close, closeStart + close.length) >= 0) {
    throw new Error('rule ownership marker is duplicated')
  }
  const lineBeforeOpen = start === 0 || content[start - 1] === '\n'
  const end = closeStart + close.length
  const lineAfterClose = end === content.length || content[end] === '\n'
  if (!lineBeforeOpen || !lineAfterClose) throw new Error('rule ownership marker must be on its own line')
  return { start, end }
}

interface RuleFileSnapshot {
  content: string
  mode: number
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

async function readRegularFile(filePath: string): Promise<RuleFileSnapshot | null> {
  try {
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink()) throw new Error('refusing to modify a symbolic-link rule target')
    if (!stat.isFile()) throw new Error('rule target is not a regular file')
    return {
      content: await fs.readFile(filePath, 'utf-8'),
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function sameSnapshot(expected: RuleFileSnapshot | null, actual: RuleFileSnapshot | null): boolean {
  if (expected === null || actual === null) return expected === actual
  return expected.content === actual.content
    && expected.mode === actual.mode
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
}

async function writeAtomic(
  filePath: string,
  content: string,
  expected: RuleFileSnapshot | null,
  opts: RuleFileWriteOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
      ...(expected === null ? {} : { mode: expected.mode & 0o777 }),
    })
    await opts.beforeAtomicRename?.(filePath, tempPath)
    const current = await readRegularFile(filePath)
    if (!sameSnapshot(expected, current)) {
      throw new RuleFileConflictError('Rule target changed while CWC was preparing the update. No changes were written; review the latest file and try again.')
    }
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function serializeFileChange<T>(filePath: string, change: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath)
  const previous = fileQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>(resolve => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => turn)
  fileQueues.set(key, queued)
  await previous.catch(() => undefined)
  try {
    return await change()
  } finally {
    release()
    if (fileQueues.get(key) === queued) fileQueues.delete(key)
  }
}

export function addRuleToFile(
  filePath: string,
  automationId: string,
  suggestion: string,
  opts: RuleFileWriteOptions = {},
): Promise<RuleFileChange> {
  return serializeFileChange(filePath, async () => {
    const existing = await readRegularFile(filePath)
    const content = existing?.content ?? ''
    if (locateRuleBlock(content, automationId)) return 'already-present'

    // Always contribute exactly one separator newline after newline-terminated content
    // (never borrow a user blank line), so removal can strip exactly one and restore
    // the user's bytes no matter how many blank lines their file already ended with.
    const separator = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n'
    await writeAtomic(filePath, `${content}${separator}${buildRuleBlock(automationId, suggestion)}\n`, existing, opts)
    return 'added'
  })
}

export function removeRuleFromFile(
  filePath: string,
  automationId: string,
  opts: RuleFileWriteOptions = {},
): Promise<RuleFileChange> {
  return serializeFileChange(filePath, async () => {
    const existing = await readRegularFile(filePath)
    if (!existing) return 'not-found'
    const located = locateRuleBlock(existing.content, automationId)
    if (!located) return 'not-found'

    let start = located.start
    let end = located.end
    // addRuleToFile contributes exactly one separator newline before the block and one
    // trailing newline after it. Consume only that framing (never a second preceding
    // newline, which is user content) so unrelated Markdown stays byte-for-byte intact.
    if (start >= 2 && existing.content.slice(start - 2, start) === '\n\n') start -= 1
    if (end < existing.content.length && existing.content[end] === '\n') end += 1
    await writeAtomic(filePath, existing.content.slice(0, start) + existing.content.slice(end), existing, opts)
    return 'removed'
  })
}
