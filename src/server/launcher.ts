import * as net from 'node:net'
import * as http from 'node:http'

export type PortState = 'cwc' | 'foreign' | 'free'

/** True iff a CWC server answers /api/health with status ok on this port. */
export function serverResponding(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('"status":"ok"')))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** True iff something accepts a TCP connection on this port. Timeout is treated
 * as in-use (conservative — better to fail loud than spawn into ambiguity). */
export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (inUse: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(inUse) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(true))
    socket.once('error', () => finish(false)) // ECONNREFUSED / unreachable → not a usable occupant
  })
}

export async function probePortState(port: number): Promise<PortState> {
  if (await serverResponding(port)) return 'cwc'
  if (await portInUse(port)) return 'foreign'
  return 'free'
}

export async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await serverResponding(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return serverResponding(port)
}

import { execFile } from 'node:child_process'

export interface Occupant { pid: number; command: string }
export type LsofRunner = (cmd: string, args: string[]) => Promise<string>

const defaultLsof: LsofRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

function parseLsof(output: string): Occupant | null {
  for (const line of output.split('\n')) {
    if (!line.trim() || line.startsWith('COMMAND')) continue
    const cols = line.trim().split(/\s+/)
    const pid = Number(cols[1])
    if (cols[0] && Number.isInteger(pid)) return { pid, command: cols[0] }
  }
  return null
}

/** Best-effort: name the process holding `port`. Returns null if lsof is
 * unavailable or yields nothing (e.g. Windows). Never throws. */
export function resolveOccupant(port: number, run: LsofRunner = defaultLsof): Promise<Occupant | null> {
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
    .then(parseLsof)
    .catch(() => null)
}

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export type StartResult = 'started' | 'already-running' | 'foreign-conflict' | 'failed'

export interface StartCtx {
  port: number
  pidFile: string
  stderrLog: string
  /** Live PID if this command owns a running server, else null. */
  isOwnedServerRunning: () => Promise<number | null>
  /** SIGTERM the owned server, wait for exit, remove its PID file. */
  restartOwnedServer: (pid: number) => Promise<void>
  probePortState: (port: number) => Promise<PortState>
  /** Spawn the detached server (output redirected to logs); return child.pid. */
  spawnServer: () => number | undefined
  waitForServer: (timeoutMs: number) => Promise<boolean>
  resolveOccupant: (port: number) => Promise<Occupant | null>
  openUrl: (url: string) => Promise<void>
  io: { log: (m: string) => void; error: (m: string) => void }
  verifyTimeoutMs?: number
}

function foreignConflictMessage(port: number, occ: Occupant | null): string {
  const who = occ ? ` (PID ${occ.pid}, ${occ.command})` : ''
  return `Port ${port} is already in use by another process that CWC didn't start${who}. ` +
    `CWC requires port ${port} and cannot use a different one. Free it — find it with ` +
    `\`lsof -i:${port}\`, then stop that process — and re-run \`npx claude-cwc\`. ` +
    `If you started CWC another way, \`npx claude-cwc stop\` may help.`
}

async function readLogTail(logPath: string, lines = 10): Promise<string> {
  try {
    const content = await fsp.readFile(logPath, 'utf-8')
    return content.trimEnd().split('\n').slice(-lines).join('\n')
  } catch { return '' }
}

export async function startCwc(ctx: StartCtx): Promise<StartResult> {
  const url = `http://localhost:${ctx.port}`

  const ownedPid = await ctx.isOwnedServerRunning()
  if (ownedPid !== null) {
    await ctx.restartOwnedServer(ownedPid)
  } else {
    const state = await ctx.probePortState(ctx.port)
    if (state === 'cwc') {
      ctx.io.log(`CWC is already running at ${url}`)
      await ctx.openUrl(url)
      return 'already-running'
    }
    if (state === 'foreign') {
      const occ = await ctx.resolveOccupant(ctx.port)
      ctx.io.error(foreignConflictMessage(ctx.port, occ))
      return 'foreign-conflict'
    }
    // 'free' → fall through to spawn
  }

  const pid = ctx.spawnServer()
  if (pid === undefined) {
    ctx.io.error('Failed to spawn CWC server process.')
    return 'failed'
  }
  await fsp.mkdir(path.dirname(ctx.pidFile), { recursive: true })
  await fsp.writeFile(ctx.pidFile, String(pid), 'utf-8')

  if (await ctx.waitForServer(ctx.verifyTimeoutMs ?? 10_000)) {
    ctx.io.log(`CWC server started (PID ${pid}) at ${url}`)
    await ctx.openUrl(url)
    return 'started'
  }

  const tail = await readLogTail(ctx.stderrLog)
  ctx.io.error(
    `CWC server did not come up on ${url}.` +
    (tail ? `\n\nServer log:\n${tail}` : '') +
    `\n\nIf the port is in use, free it (\`lsof -i:${ctx.port}\`) and re-run \`npx claude-cwc\`.`,
  )
  try { await fsp.unlink(ctx.pidFile) } catch { /* already gone */ }
  return 'failed'
}
