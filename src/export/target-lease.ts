import * as path from 'node:path'
import * as fs from 'node:fs/promises'

const targetTails = new Map<string, Promise<void>>()
let registrationQueue: Promise<void> = Promise.resolve()

function normalizeCase(value: string): string {
  // Windows is case-insensitive, and the default macOS filesystem is too. It is
  // safe to serialize distinct case-sensitive Darwin paths unnecessarily; it is
  // not safe to let aliases of one deployment mutate it concurrently.
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value
}

/** Resolve aliases even when the export descendants do not exist yet. realpath
 * the nearest existing ancestor, then append the missing lexical suffix. */
async function normalizedLeaseKey(root: string): Promise<string> {
  const resolved = path.normalize(path.resolve(root))
  let ancestor = resolved
  const missing: string[] = []

  for (;;) {
    try {
      const canonicalAncestor = await fs.realpath(ancestor)
      return normalizeCase(path.normalize(path.join(canonicalAncestor, ...missing)))
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return normalizeCase(resolved)
      missing.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

async function withSingleLease<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = targetTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => held)
  targetTails.set(key, tail)

  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release()
    if (targetTails.get(key) === tail) targetTails.delete(key)
  }
}

/** Serialize mutations that share any export filesystem root. Sorted acquisition
 * keeps custom skills-directory combinations deadlock-free while the target's
 * `.claude` root ensures exports and deletes for one deployment cannot race. */
export async function withExportTargetLease<T>(
  roots: string[],
  action: () => Promise<T>,
): Promise<T> {
  // Canonicalization is asynchronous. Register requests through a short FIFO so
  // a later request cannot overtake an earlier delete/export merely because its
  // realpath lookup completed first. The queue is released once the first lease
  // tail is installed; it does not serialize the actions globally.
  return new Promise<T>((resolve, reject) => {
    const registration = registrationQueue.then(async () => {
      try {
        const keys = [...new Set(await Promise.all(roots.map(normalizedLeaseKey)))].sort()
        const acquire = async (index: number): Promise<T> => {
          if (index === keys.length) return action()
          return withSingleLease(keys[index], () => acquire(index + 1))
        }
        void acquire(0).then(resolve, reject)
      } catch (err) {
        reject(err)
      }
    })
    registrationQueue = registration.then(() => undefined, () => undefined)
  })
}
