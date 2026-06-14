#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as child_process from 'node:child_process'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import open from 'open'
import { SERVICE_LABEL, buildServerPlist } from '../src/server/service-plist.js'

const PORT = 3579
const CWC_DIR = path.join(os.homedir(), '.cwc')
const PID_FILE = path.join(CWC_DIR, 'server.pid')
const SKILL_VERSION_FILE = path.join(CWC_DIR, '.skill-version')
const SKILL_DECLINED_FILE = path.join(CWC_DIR, '.skill-declined')
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
const SKILL_DEST = path.join(CLAUDE_SKILLS_DIR, 'cwc-generate-workflow', 'SKILL.md')

const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`)

// ─── Skill management ────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

async function getSkillSource(): Promise<string | null> {
  // Skill ships alongside the binary at dist/skills/cwc-generate-workflow/SKILL.md
  const candidate = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'cwc-generate-workflow', 'SKILL.md')
  try { await fs.access(candidate); return candidate } catch { return null }
}

async function readInstalledVersion(): Promise<string | null> {
  try { return (await fs.readFile(SKILL_VERSION_FILE, 'utf-8')).trim() } catch { return null }
}

async function installSkill(source: string, version: string): Promise<void> {
  await fs.mkdir(path.dirname(SKILL_DEST), { recursive: true })
  await fs.copyFile(source, SKILL_DEST)
  await fs.writeFile(SKILL_VERSION_FILE, version, 'utf-8')
}

async function maybeManageSkill(version: string): Promise<void> {
  const source = await getSkillSource()
  if (!source) return // skill not bundled in this build

  const installedVersion = await readInstalledVersion()
  const declined = await fs.access(SKILL_DECLINED_FILE).then(() => true).catch(() => false)

  if (installedVersion) {
    // Already installed — silently update if version changed
    if (installedVersion !== version) {
      await installSkill(source, version)
    }
    return
  }

  if (declined) return // user said no, don't ask again

  // First time — prompt
  console.log(`
┌─────────────────────────────────────────────────────────────────┐
│  Claude Workflow Composer — optional skill install              │
│                                                                 │
│  CWC includes a Claude Code skill that lets you generate       │
│  workflows from plain-English descriptions directly inside      │
│  Claude Code — no API key needed.                               │
│                                                                 │
│  Usage: just ask Claude Code to generate a workflow and it      │
│  will create a .cwc file that appears in your CWC canvas.       │
│                                                                 │
│  This installs one file:                                        │
│    ~/.claude/skills/cwc-generate-workflow/SKILL.md             │
│                                                                 │
│  Uninstall anytime: npx claude-cwc uninstall-skill             │
└─────────────────────────────────────────────────────────────────┘`)

  const answer = await ask('  Install the generate-workflow skill? (y/N): ')
  if (answer.toLowerCase() === 'y') {
    await installSkill(source, version)
    console.log('  ✓ Skill installed. Ask Claude Code to "generate a workflow" to use it.\n')
  } else {
    await fs.mkdir(CWC_DIR, { recursive: true })
    await fs.writeFile(SKILL_DECLINED_FILE, '', 'utf-8')
    console.log('  Skipped. You can install later by deleting ~/.cwc/.skill-declined and rerunning.\n')
  }
}

async function uninstallSkill(): Promise<void> {
  try {
    await fs.unlink(SKILL_DEST)
    await fs.unlink(SKILL_VERSION_FILE).catch(() => {})
    console.log('Skill uninstalled: ~/.claude/skills/cwc-generate-workflow/SKILL.md removed.')
  } catch {
    console.log('Skill not found — nothing to uninstall.')
  }
}

// ─── Server management ───────────────────────────────────────────────────────

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
    process.kill(existingPid, 'SIGTERM')
    try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 300))
  }

  // dist/src/server/start.js — relative to dist/bin/cwc.js
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'start.js')

  const child = child_process.spawn(process.execPath, [serverEntry, String(PORT)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  if (child.pid === undefined) {
    console.error('Failed to spawn CWC server process.')
    process.exit(1)
  }
  const pid = child.pid
  await writePid(pid)
  console.log(`CWC server started (PID ${pid}) at http://localhost:${PORT}`)

  // Brief wait for server readiness, then open browser
  await new Promise((r) => setTimeout(r, 800))
  await open(`http://localhost:${PORT}`)
}

async function installService(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('install-service is macOS-only (launchd). On other platforms, keep `npx cwc` running.')
    return
  }
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'start.js')
  const plist = buildServerPlist({ nodePath: process.execPath, serverEntry, port: PORT })
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true })
  await fs.writeFile(PLIST_PATH, plist, 'utf-8')
  await new Promise<void>((resolve) => {
    child_process.execFile('launchctl', ['unload', '-w', PLIST_PATH], () => resolve())  // ignore "not loaded"
  })
  await new Promise<void>((resolve, reject) => {
    child_process.execFile('launchctl', ['load', '-w', PLIST_PATH], (err) => err ? reject(err) : resolve())
  })
  console.log(`CWC service installed — the server now starts at login (${PLIST_PATH}).`)
}

async function uninstallService(): Promise<void> {
  if (process.platform !== 'darwin') { console.log('No service to remove on this platform.'); return }
  await new Promise<void>((resolve) => {
    child_process.execFile('launchctl', ['unload', '-w', PLIST_PATH], () => resolve())
  })
  try { await fs.unlink(PLIST_PATH); console.log('CWC service removed.') }
  catch { console.log('CWC service was not installed.') }
}

const [,, command] = process.argv

if (command === 'stop') {
  await stopServer()
} else if (command === 'uninstall-skill') {
  await uninstallSkill()
} else if (command === 'install-service') {
  await installService()
} else if (command === 'uninstall-service') {
  await uninstallService()
} else {
  const { version } = JSON.parse(
    await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')
  ) as { version: string }
  await maybeManageSkill(version)
  await startServer()
}
