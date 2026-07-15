/** Recognize absolute POSIX, Windows drive-letter, and Windows UNC paths. */
export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim()
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(trimmed)
}
