import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ReversibleFileDeletion {
  filePath: string
  backupPath: string
  content: string
  mode: number
  parentMode: number
  backupReady: boolean
  preserveBackup: boolean
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lstatIfExists(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return null
    throw error
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function backupPathFor(filePath: string, backupDirectory: string): string {
  const suffix = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return path.join(
    backupDirectory,
    `.${path.basename(filePath)}.cwc-delete-${suffix}-${randomUUID()}.bak`,
  )
}

/**
 * Preserve the exact inode immediately before removing a live deployment file.
 * The backup remains on the same filesystem so rollback can restore it with one
 * atomic rename. Callers must already have verified artifact ownership.
 */
export async function stageReversibleFileDeletion(
  filePath: string,
  expectedContent: string,
  backupDirectory = path.dirname(filePath),
): Promise<ReversibleFileDeletion> {
  const [initial, parent, backupRoot] = await Promise.all([
    fs.lstat(filePath),
    fs.lstat(path.dirname(filePath)),
    fs.lstat(backupDirectory),
  ])
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`Deployment target ${filePath} is not a regular file.`)
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`Deployment directory ${path.dirname(filePath)} is not a regular directory.`)
  }
  if (backupRoot.isSymbolicLink() || !backupRoot.isDirectory()) {
    throw new Error(`Deployment backup directory ${backupDirectory} is not a regular directory.`)
  }
  const initialContent = await fs.readFile(filePath, 'utf-8')
  if (initialContent !== expectedContent) {
    throw new Error(`Deployment target ${filePath} changed before deletion.`)
  }

  const backupPath = backupPathFor(filePath, backupDirectory)
  let backupReady = false
  try {
    await fs.link(filePath, backupPath)
    backupReady = true
    const [live, backup, liveContent, backupContent] = await Promise.all([
      fs.lstat(filePath),
      fs.lstat(backupPath),
      fs.readFile(filePath, 'utf-8'),
      fs.readFile(backupPath, 'utf-8'),
    ])
    if (!sameFile(initial, live) || !sameFile(live, backup)
      || liveContent !== expectedContent || backupContent !== expectedContent) {
      throw new Error(`Deployment target ${filePath} changed before deletion.`)
    }
    await fs.unlink(filePath)
    return {
      filePath,
      backupPath,
      content: expectedContent,
      mode: Number(initial.mode) & 0o777,
      parentMode: Number(parent.mode) & 0o777,
      backupReady: true,
      preserveBackup: false,
    }
  } catch (error) {
    if (backupReady) await fs.unlink(backupPath).catch(() => undefined)
    throw error
  }
}

async function rollbackFileDeletion(entry: ReversibleFileDeletion): Promise<void> {
  if (!entry.backupReady) return
  const current = await lstatIfExists(entry.filePath)
  if (current) {
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error(`Deployment target ${entry.filePath} changed before rollback; its backup remains at ${entry.backupPath}.`)
    }
    const currentContent = await fs.readFile(entry.filePath, 'utf-8')
    if (currentContent !== entry.content || (Number(current.mode) & 0o777) !== entry.mode) {
      throw new Error(`Deployment target ${entry.filePath} changed before rollback; its backup remains at ${entry.backupPath}.`)
    }
    await fs.unlink(entry.backupPath)
    entry.backupReady = false
    return
  }

  const parentPath = path.dirname(entry.filePath)
  const parent = await lstatIfExists(parentPath)
  if (!parent) {
    await fs.mkdir(parentPath, { recursive: true, mode: entry.parentMode })
    await fs.chmod(parentPath, entry.parentMode)
  } else if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`Deployment directory ${parentPath} changed before rollback; its backup remains at ${entry.backupPath}.`)
  }
  await fs.rename(entry.backupPath, entry.filePath)
  entry.backupReady = false
}

/** Restore every deleted file in reverse order without overwriting external work. */
export async function rollbackFileDeletions(entries: ReversibleFileDeletion[]): Promise<void> {
  const errors: string[] = []
  for (const entry of [...entries].reverse()) {
    try {
      await rollbackFileDeletion(entry)
    } catch (error) {
      entry.preserveBackup = entry.backupReady
      errors.push(errorMessage(error))
    }
  }
  if (errors.length > 0) {
    throw new Error(`Deployment rollback was incomplete: ${errors.join(' ')}`)
  }
}

/** Backup cleanup is post-commit housekeeping and must never turn success into failure. */
export async function finalizeFileDeletions(
  entries: ReversibleFileDeletion[],
  onWarning?: (message: string) => void,
): Promise<void> {
  for (const entry of entries) {
    if (!entry.backupReady || entry.preserveBackup) continue
    try {
      await fs.unlink(entry.backupPath)
      entry.backupReady = false
    } catch (error) {
      entry.preserveBackup = true
      onWarning?.(`The deployment succeeded, but its deletion backup could not be removed: ${entry.backupPath} (${errorMessage(error)})`)
    }
  }
}
