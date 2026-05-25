#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as child_process from 'node:child_process'
import { fileURLToPath } from 'node:url'
import open from 'open'

const PORT = 3579
const CWC_DIR = path.join(os.homedir(), '.cwc')
const PID_FILE = path.join(CWC_DIR, 'server.pid')

async function isRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf-8')
    const pid = parseInt(raw.trim(), 10)
    return isNaN(pid) ? null : pid
  } catch { return null }
}

async function writePid(pid: number): Promise<void> {
  await fs.mkdir(CWC_DIR, { recursive: true })
  await fs.writeFile(PID_FILE, String(pid), 'utf-8')
}

async function stopServer(): Promise<void> {
  const pid = await readPid()
  if (pid && await isRunning(pid)) {
    process.kill(pid, 'SIGTERM')
    console.log(`CWC server (PID ${pid}) stopped.`)
  } else {
    console.log('CWC server is not running.')
  }
  try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
}

async function startServer(): Promise<void> {
  const existingPid = await readPid()
  if (existingPid && await isRunning(existingPid)) {
    console.log(`CWC server already running (PID ${existingPid})`)
    await open(`http://localhost:${PORT}`)
    return
  }

  // dist/src/server/start.js — relative to dist/bin/cwc.js
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'start.js')

  const child = child_process.spawn(process.execPath, [serverEntry, String(PORT)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const pid = child.pid!
  await writePid(pid)
  console.log(`CWC server started (PID ${pid}) at http://localhost:${PORT}`)

  // Brief wait for server readiness, then open browser
  await new Promise((r) => setTimeout(r, 800))
  await open(`http://localhost:${PORT}`)
}

const [,, command] = process.argv

if (command === 'stop') {
  await stopServer()
} else {
  await startServer()
}
