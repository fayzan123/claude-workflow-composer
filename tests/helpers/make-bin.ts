import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Windows cannot spawn extension-less shebang scripts, so each fake binary is a
// Node script plus a .cmd shim there — which also exercises the runner's shell path.
export async function makeBin(dir: string, name: string, source: string): Promise<string> {
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, `${name}.js`), source)
    const cmd = path.join(dir, `${name}.cmd`)
    await fs.writeFile(cmd, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`)
    return cmd
  }
  const bin = path.join(dir, name)
  await fs.writeFile(bin, `#!/usr/bin/env node\n${source}`, { mode: 0o755 })
  return bin
}
