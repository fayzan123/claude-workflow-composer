// src/server/config.ts
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

export interface CwcConfig { notifications: { macos: boolean; webhookUrl?: string } }

/** Synchronous by design — createApp stays sync. */
export function loadConfig(filePath: string): CwcConfig {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<CwcConfig>
    return { notifications: { macos: raw.notifications?.macos ?? process.platform === 'darwin', webhookUrl: raw.notifications?.webhookUrl } }
  } catch {
    return { notifications: { macos: process.platform === 'darwin' } }
  }
}

export async function saveConfig(filePath: string, config: CwcConfig): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(config, null, 2))
  await fs.rename(tmp, filePath)
}
