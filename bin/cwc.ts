#!/usr/bin/env node
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as child_process from 'node:child_process'
import * as fsSync from 'node:fs'
import * as readline from 'node:readline'
import {
  startCwc,
  describeIdleStop,
  probePortState,
  portInUse,
  serverResponding,
  waitForServer,
  resolveOccupant,
} from '../src/server/launcher.js'
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
const SERVICE_LOG_DIR = path.join(CWC_DIR, 'logs')
const SERVICE_STDOUT = path.join(SERVICE_LOG_DIR, 'server.out.log')
const SERVICE_STDERR = path.join(SERVICE_LOG_DIR, 'server.err.log')
const SERVICE_PATH = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

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

/** A launchd service is installed iff its plist exists. When it does, the service —
 * not a detached PID — is the source of truth for the running server, so the CLI must
 * not spawn a competing process (port collision) or try to SIGTERM a stale PID. */
async function isServiceInstalled(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try { await fs.access(PLIST_PATH); return true } catch { return false }
}

function launchctl(args: string[]): Promise<void> {
  // Best-effort: "already loaded" / "not loaded" exit non-zero but are benign here.
  return new Promise((resolve) => { child_process.execFile('launchctl', args, () => resolve()) })
}

function launchctlStrict(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    child_process.execFile('launchctl', args, (err, _stdout, stderr) => {
      if (!err) { resolve(); return }
      const detail = String(stderr || err.message || '').trim()
      reject(new Error(`launchctl ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function stopPidBackedServer(): Promise<void> {
  const pid = await readPid()
  if (!pid || !(await isRunning(pid))) {
    try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* exited between check and signal */ }
  for (let i = 0; i < 15 && await isRunning(pid); i++) await new Promise((r) => setTimeout(r, 100))
  try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
}

async function stopServer(): Promise<void> {
  if (await isServiceInstalled()) {
    // unload -w stops it now AND disables autostart, so KeepAlive can't respawn it and
    // it won't return at next login until re-enabled (`npx claude-cwc` or install-service).
    await launchctl(['unload', '-w', PLIST_PATH])
    console.log('CWC service stopped (autostart disabled). Run `npx claude-cwc` to start it again, or `npx claude-cwc uninstall-service` to remove it.')
    return
  }
  const pid = await readPid()
  if (pid && await isRunning(pid)) {
    process.kill(pid, 'SIGTERM')
    console.log(`CWC server (PID ${pid}) stopped.`)
  } else {
    console.log(await describeIdleStop(PORT, { portInUse, resolveOccupant }))
  }
  try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
}

async function startServer(): Promise<void> {
  // If a service is installed, ensure it's loaded (idempotent) rather than spawning a
  // second server that would collide on the port. load -w re-enables it if stop
  // had disabled it.
  if (await isServiceInstalled()) {
    await launchctl(['load', '-w', PLIST_PATH])
    for (let i = 0; i < 12 && !(await serverResponding(PORT)); i++) await new Promise((r) => setTimeout(r, 300))
    if (await serverResponding(PORT)) {
      console.log(`CWC is running as a service at http://localhost:${PORT}`)
      await open(`http://localhost:${PORT}`)
    } else {
      console.error('CWC service is installed but the server did not come up. Check `launchctl list | grep cwc`, or run `npx claude-cwc uninstall-service` to run it manually.')
    }
    return
  }

  // dist/src/server/start.js — relative to dist/bin/cwc.js
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'start.js')

  const result = await startCwc({
    port: PORT,
    pidFile: PID_FILE,
    stderrLog: SERVICE_STDERR,
    isOwnedServerRunning: async () => {
      const pid = await readPid()
      return pid && (await isRunning(pid)) ? pid : null
    },
    restartOwnedServer: async (pid) => {
      try { process.kill(pid, 'SIGTERM') } catch { /* exited already */ }
      try { await fs.unlink(PID_FILE) } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 300))
    },
    probePortState,
    spawnServer: () => {
      fsSync.mkdirSync(SERVICE_LOG_DIR, { recursive: true })
      const out = fsSync.openSync(SERVICE_STDOUT, 'a')
      const err = fsSync.openSync(SERVICE_STDERR, 'a')
      const child = child_process.spawn(process.execPath, [serverEntry, String(PORT)], {
        detached: true,
        stdio: ['ignore', out, err],
      })
      child.unref()
      return child.pid
    },
    waitForServer: (ms) => waitForServer(PORT, ms),
    resolveOccupant: (p) => resolveOccupant(p),
    openUrl: async (u) => { await open(u) },
    io: { log: (m) => console.log(m), error: (m) => console.error(m) },
  })

  if (result === 'foreign-conflict' || result === 'failed') process.exit(1)
}

async function installService(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('install-service is macOS-only (launchd). On other platforms, keep `npx claude-cwc` running.')
    return
  }
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'start.js')
  await fs.access(serverEntry).catch(() => {
    throw new Error(`CWC server entry was not found at ${serverEntry}. Run this command from the published package or rebuild with \`npm run build\`.`)
  })
  await fs.mkdir(CWC_DIR, { recursive: true })
  await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true })
  await fs.mkdir(SERVICE_LOG_DIR, { recursive: true })
  await launchctl(['unload', '-w', PLIST_PATH])
  await stopPidBackedServer()
  if (await serverResponding(PORT)) {
    throw new Error(`Port ${PORT} is already in use by another CWC server or process. Stop it first, then rerun \`npx claude-cwc install-service\`.`)
  }
  const plist = buildServerPlist({
    nodePath: process.execPath,
    serverEntry,
    port: PORT,
    workingDirectory: os.homedir(),
    standardOutPath: SERVICE_STDOUT,
    standardErrorPath: SERVICE_STDERR,
    environment: { HOME: os.homedir(), PATH: SERVICE_PATH },
    throttleInterval: 10,
  })
  await fs.writeFile(PLIST_PATH, plist, 'utf-8')
  await launchctlStrict(['load', '-w', PLIST_PATH])
  if (!(await waitForServer(PORT, 12000))) {
    await launchctl(['unload', '-w', PLIST_PATH])
    throw new Error(`CWC service did not respond on http://localhost:${PORT}; it has been unloaded so launchd will not keep retrying. Check ${SERVICE_STDERR} and ${SERVICE_STDOUT}.`)
  }
  console.log(`CWC service installed and running at http://localhost:${PORT}`)
  console.log(`LaunchAgent: ${PLIST_PATH}`)
  console.log(`Logs: ${SERVICE_STDERR}`)
}

async function uninstallService(): Promise<void> {
  if (process.platform !== 'darwin') { console.log('No service to remove on this platform.'); return }
  await new Promise<void>((resolve) => {
    child_process.execFile('launchctl', ['unload', '-w', PLIST_PATH], () => resolve())
  })
  try { await fs.unlink(PLIST_PATH); console.log('CWC service removed.') }
  catch { console.log('CWC service was not installed.') }
}

async function main(): Promise<void> {
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
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
