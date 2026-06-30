# Launcher Port-Collision Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx claude-cwc` fail loudly and informatively when port 3579 cannot be bound, instead of reporting false success and opening a dead/foreign browser tab.

**Architecture:** Extract the server start/stop decision logic out of the untestable `bin/cwc.ts` script into a new testable module `src/server/launcher.ts` with injectable dependencies. The launcher classifies port 3579 as `cwc` / `foreign` / `free`, reuses a healthy CWC server, restarts one we own, fails loud on a foreign occupant, and verifies the spawned server is actually responding before claiming success. `bin/cwc.ts` becomes a thin caller that supplies the real implementations and maps results to exit codes.

**Tech Stack:** TypeScript (ESM, `node:` built-ins), Node `net`/`http`/`child_process`, Vitest with real sockets and real temp filesystems (no mocks).

## Global Constraints

- Port **3579** stays canonical and must not change — exported workflow skills hardcode `http://localhost:3579/api/runs/events` (`src/prose-generator.ts:243`) and the client shows `http://localhost:3579/api/triggers/...` as copy-paste URLs. No port fallback. No `CWC_PORT` override.
- Tests use real temp filesystems (`fs.mkdtemp`) and real sockets — never introduce mocks for filesystem or network operations.
- ESM throughout: relative imports of compiled output use the `.js` extension (e.g. `import { startCwc } from '../src/server/launcher.js'`).
- The launchd **service** branch (`isServiceInstalled()` path) and the skill-install prompt (`maybeManageSkill`) are **unchanged**.
- Run a single test file with `npx vitest run tests/server/launcher.test.ts`. Typecheck with `npm run typecheck`.
- Subagents: Sonnet or above, never Haiku.

---

## File Structure

- **Create** `src/server/launcher.ts` — port probes, occupant resolution, and the `startCwc` / `describeIdleStop` decision functions. Pure-ish; all effectful behavior is injected.
- **Create** `tests/server/launcher.test.ts` — unit tests for every launcher export using real sockets + temp dirs + injected fakes.
- **Modify** `bin/cwc.ts` — delete the moved helpers, import from `launcher.js`, rewrite `startServer()`'s non-service path and `stopServer()`'s "not running" branch to delegate to the launcher.

---

## Task 1: Port-probe helpers in `launcher.ts`

**Files:**
- Create: `src/server/launcher.ts`
- Test: `tests/server/launcher.test.ts`

**Interfaces:**
- Produces:
  - `type PortState = 'cwc' | 'foreign' | 'free'`
  - `serverResponding(port: number): Promise<boolean>`
  - `portInUse(port: number, host?: string, timeoutMs?: number): Promise<boolean>`
  - `probePortState(port: number): Promise<PortState>`
  - `waitForServer(port: number, timeoutMs: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `tests/server/launcher.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import * as net from 'node:net'
import * as http from 'node:http'
import { portInUse, serverResponding, probePortState, waitForServer } from '../../src/server/launcher.js'

const openSockets: Array<net.Server | http.Server> = []
afterEach(async () => {
  await Promise.all(openSockets.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}
function rawListener(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer()
    openSockets.push(s)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}
function healthListener(port: number, body = '{"status":"ok"}'): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body) }
      else { res.writeHead(404); res.end() }
    })
    openSockets.push(s)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

describe('port probes', () => {
  it('portInUse: false when free, true when a socket listens', async () => {
    const port = await freePort()
    expect(await portInUse(port)).toBe(false)
    await rawListener(port)
    expect(await portInUse(port)).toBe(true)
  })

  it('serverResponding: true only for a CWC-style /api/health responder', async () => {
    const free = await freePort()
    expect(await serverResponding(free)).toBe(false)
    const rawPort = await freePort()
    await rawListener(rawPort)
    expect(await serverResponding(rawPort)).toBe(false)
    const okPort = await freePort()
    await healthListener(okPort)
    expect(await serverResponding(okPort)).toBe(true)
  })

  it('probePortState: free / foreign / cwc', async () => {
    const free = await freePort()
    expect(await probePortState(free)).toBe('free')
    const foreign = await freePort()
    await rawListener(foreign)
    expect(await probePortState(foreign)).toBe('foreign')
    const cwc = await freePort()
    await healthListener(cwc)
    expect(await probePortState(cwc)).toBe('cwc')
  })

  it('waitForServer: resolves true when healthy, false after timeout when free', async () => {
    const okPort = await freePort()
    await healthListener(okPort)
    expect(await waitForServer(okPort, 2000)).toBe(true)
    const free = await freePort()
    expect(await waitForServer(free, 600)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: FAIL — cannot resolve `../../src/server/launcher.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/server/launcher.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts tests/server/launcher.test.ts
git commit -m "feat(launcher): port-state probe helpers (cwc/foreign/free)"
```

---

## Task 2: Resolve the port occupant via `lsof`

**Files:**
- Modify: `src/server/launcher.ts`
- Test: `tests/server/launcher.test.ts`

**Interfaces:**
- Produces:
  - `interface Occupant { pid: number; command: string }`
  - `type LsofRunner = (cmd: string, args: string[]) => Promise<string>`
  - `resolveOccupant(port: number, run?: LsofRunner): Promise<Occupant | null>`

- [ ] **Step 1: Write the failing test**

Append to `tests/server/launcher.test.ts`:

```ts
import { resolveOccupant } from '../../src/server/launcher.js'

describe('resolveOccupant', () => {
  const SAMPLE = [
    'COMMAND   PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    50746 fayzanmalik   18u  IPv4 0xeea29d7d1d8af814      0t0  TCP 127.0.0.1:3579 (LISTEN)',
  ].join('\n')

  it('parses pid and command from lsof output', async () => {
    const occ = await resolveOccupant(3579, async () => SAMPLE)
    expect(occ).toEqual({ pid: 50746, command: 'node' })
  })

  it('returns null when the runner errors (lsof missing)', async () => {
    const occ = await resolveOccupant(3579, async () => { throw new Error('lsof: not found') })
    expect(occ).toBeNull()
  })

  it('returns null when there is no listener line', async () => {
    const occ = await resolveOccupant(3579, async () => 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n')
    expect(occ).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: FAIL — `resolveOccupant` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/launcher.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts tests/server/launcher.test.ts
git commit -m "feat(launcher): best-effort lsof occupant resolution"
```

---

## Task 3: `startCwc` decision function

**Files:**
- Modify: `src/server/launcher.ts`
- Test: `tests/server/launcher.test.ts`

**Interfaces:**
- Consumes: `PortState`, `Occupant`, `probePortState`, `waitForServer`, `resolveOccupant` (Tasks 1–2).
- Produces:
  - `type StartResult = 'started' | 'already-running' | 'foreign-conflict' | 'failed'`
  - `interface StartCtx { port; pidFile; stderrLog; isOwnedServerRunning; restartOwnedServer; probePortState; spawnServer; waitForServer; resolveOccupant; openUrl; io; verifyTimeoutMs? }`
  - `startCwc(ctx: StartCtx): Promise<StartResult>`

- [ ] **Step 1: Write the failing test**

Append to `tests/server/launcher.test.ts`:

```ts
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startCwc, type StartCtx } from '../../src/server/launcher.js'

describe('startCwc', () => {
  let tmp: string
  let base: StartCtx
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launcher-'))
    base = {
      port: 3579,
      pidFile: path.join(tmp, 'server.pid'),
      stderrLog: path.join(tmp, 'server.err.log'),
      isOwnedServerRunning: async () => null,
      restartOwnedServer: async () => {},
      probePortState: async () => 'free',
      spawnServer: () => 4242,
      waitForServer: async () => true,
      resolveOccupant: async () => null,
      openUrl: async () => {},
      io: { log: () => {}, error: () => {} },
      verifyTimeoutMs: 50,
    }
  })

  it('foreign occupant: foreign-conflict, no spawn, no browser, names the pid', async () => {
    let spawned = 0; const opened: string[] = []; const errs: string[] = []
    const result = await startCwc({ ...base,
      probePortState: async () => 'foreign',
      spawnServer: () => { spawned++; return 1 },
      openUrl: async (u) => { opened.push(u) },
      resolveOccupant: async () => ({ pid: 50746, command: 'node' }),
      io: { log: () => {}, error: (m) => errs.push(m) } })
    expect(result).toBe('foreign-conflict')
    expect(spawned).toBe(0)
    expect(opened).toEqual([])
    expect(errs[0]).toContain('Port 3579 is already in use')
    expect(errs[0]).toContain('PID 50746, node')
  })

  it('free port: spawns, verifies, reports started, opens browser, writes pid', async () => {
    let spawned = 0; const opened: string[] = []; const logs: string[] = []
    const result = await startCwc({ ...base,
      probePortState: async () => 'free',
      spawnServer: () => { spawned++; return 4242 },
      waitForServer: async () => true,
      openUrl: async (u) => { opened.push(u) },
      io: { log: (m) => logs.push(m), error: () => {} } })
    expect(result).toBe('started')
    expect(spawned).toBe(1)
    expect(opened).toEqual(['http://localhost:3579'])
    expect(logs.join('\n')).toContain('CWC server started (PID 4242)')
    expect(await fs.readFile(base.pidFile, 'utf-8')).toBe('4242')
  })

  it('server never becomes healthy: failed, surfaces log tail, no browser, removes pid', async () => {
    await fs.writeFile(base.stderrLog,
      "CWC server running on http://localhost:3579\nPort 3579 is already in use. Run 'npx claude-cwc stop' to kill the existing server.\n")
    const opened: string[] = []; const errs: string[] = []
    const result = await startCwc({ ...base,
      probePortState: async () => 'free',
      spawnServer: () => 4242,
      waitForServer: async () => false,
      openUrl: async (u) => { opened.push(u) },
      io: { log: () => {}, error: (m) => errs.push(m) } })
    expect(result).toBe('failed')
    expect(opened).toEqual([])
    expect(errs[0]).toContain('Port 3579 is already in use')
    await expect(fs.access(base.pidFile)).rejects.toThrow()
  })

  it('healthy CWC already running and unowned: reuses, opens browser, does not spawn', async () => {
    let spawned = 0; const opened: string[] = []; const logs: string[] = []
    const result = await startCwc({ ...base,
      isOwnedServerRunning: async () => null,
      probePortState: async () => 'cwc',
      spawnServer: () => { spawned++; return 1 },
      openUrl: async (u) => { opened.push(u) },
      io: { log: (m) => logs.push(m), error: () => {} } })
    expect(result).toBe('already-running')
    expect(spawned).toBe(0)
    expect(opened).toEqual(['http://localhost:3579'])
    expect(logs.join('\n')).toContain('already running')
  })

  it('owns a live server: restarts it then spawns fresh, skipping the probe', async () => {
    let restarted: number | null = null; let spawned = 0; let probed = 0
    const result = await startCwc({ ...base,
      isOwnedServerRunning: async () => 7777,
      restartOwnedServer: async (pid) => { restarted = pid },
      probePortState: async () => { probed++; return 'free' },
      spawnServer: () => { spawned++; return 4242 },
      waitForServer: async () => true,
      io: { log: () => {}, error: () => {} } })
    expect(restarted).toBe(7777)
    expect(probed).toBe(0)
    expect(spawned).toBe(1)
    expect(result).toBe('started')
  })
})
```

Add `beforeEach` to the import from vitest at the top of the file: `import { describe, it, expect, afterEach, beforeEach } from 'vitest'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: FAIL — `startCwc` / `StartCtx` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/launcher.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts tests/server/launcher.test.ts
git commit -m "feat(launcher): startCwc decision tree with verify-after-spawn"
```

---

## Task 4: `describeIdleStop` — honest `stop` message

**Files:**
- Modify: `src/server/launcher.ts`
- Test: `tests/server/launcher.test.ts`

**Interfaces:**
- Consumes: `Occupant` (Task 2).
- Produces: `describeIdleStop(port: number, deps: { portInUse: (p: number) => Promise<boolean>; resolveOccupant: (p: number) => Promise<Occupant | null> }): Promise<string>`

- [ ] **Step 1: Write the failing test**

Append to `tests/server/launcher.test.ts`:

```ts
import { describeIdleStop } from '../../src/server/launcher.js'

describe('describeIdleStop', () => {
  it('foreign occupant: reports the occupant, not "not running"', async () => {
    const msg = await describeIdleStop(3579, {
      portInUse: async () => true,
      resolveOccupant: async () => ({ pid: 50746, command: 'node' }),
    })
    expect(msg).toContain("Port 3579 is held by a process CWC didn't start")
    expect(msg).toContain('PID 50746, node')
  })

  it('free port: reports not running', async () => {
    const msg = await describeIdleStop(3579, {
      portInUse: async () => false,
      resolveOccupant: async () => null,
    })
    expect(msg).toBe('CWC server is not running.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: FAIL — `describeIdleStop` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/launcher.ts`:

```ts
export async function describeIdleStop(
  port: number,
  deps: { portInUse: (p: number) => Promise<boolean>; resolveOccupant: (p: number) => Promise<Occupant | null> },
): Promise<string> {
  if (await deps.portInUse(port)) {
    const occ = await deps.resolveOccupant(port)
    const who = occ ? ` (PID ${occ.pid}, ${occ.command})` : ''
    return `Port ${port} is held by a process CWC didn't start${who}. ` +
      `CWC isn't managing it. Inspect it with: lsof -i:${port}`
  }
  return 'CWC server is not running.'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/launcher.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server/launcher.ts tests/server/launcher.test.ts
git commit -m "feat(launcher): honest idle-stop message for foreign occupants"
```

---

## Task 5: Wire `bin/cwc.ts` to the launcher

**Files:**
- Modify: `bin/cwc.ts` (imports; delete moved `serverResponding`/`waitForServer`; rewrite `startServer()` non-service path; rewrite `stopServer()` idle branch)

**Interfaces:**
- Consumes: `startCwc`, `describeIdleStop`, `probePortState`, `portInUse`, `serverResponding`, `waitForServer`, `resolveOccupant` from `../src/server/launcher.js`.

> No new unit test: `bin/cwc.ts` is a top-level script with no existing test harness (consistent with the repo — there are no `tests/bin/*`). Its behavior is covered by the launcher unit tests plus the manual reproduction in Step 6.

- [ ] **Step 1: Add the sync-fs import and the launcher import**

In `bin/cwc.ts`, the existing imports include `import * as fs from 'node:fs/promises'`. Add directly below the existing `import * as child_process from 'node:child_process'` line:

```ts
import * as fsSync from 'node:fs'
import {
  startCwc,
  describeIdleStop,
  probePortState,
  portInUse,
  serverResponding,
  waitForServer,
  resolveOccupant,
} from '../src/server/launcher.js'
```

- [ ] **Step 2: Delete the now-duplicated local helpers**

Delete the local `serverResponding` function (the `function serverResponding(): Promise<boolean> { ... }` block) and the local `waitForServer` function (the `async function waitForServer(timeoutMs: number): Promise<boolean> { ... }` block) from `bin/cwc.ts` — they are now imported from `launcher.js`.

The remaining local callers must pass the port explicitly:
- In `startServer()`'s service branch, change `!(await serverResponding())` to `!(await serverResponding(PORT))` and `await serverResponding()` to `await serverResponding(PORT)`.
- In `installService()`, change `if (await serverResponding())` to `if (await serverResponding(PORT))` and `if (!(await waitForServer(12000)))` to `if (!(await waitForServer(PORT, 12000)))`.

- [ ] **Step 3: Replace the non-service path of `startServer()`**

In `startServer()`, the service branch (the `if (await isServiceInstalled()) { ... return }` block) is unchanged. Replace **everything after** that block — i.e. from `const existingPid = await readPid()` through the end of the function — with:

```ts
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
    openUrl: (u) => open(u),
    io: { log: (m) => console.log(m), error: (m) => console.error(m) },
  })

  if (result === 'foreign-conflict' || result === 'failed') process.exit(1)
```

- [ ] **Step 4: Replace the idle branch of `stopServer()`**

In `stopServer()`, the service branch and the `if (pid && await isRunning(pid))` branch are unchanged. Replace only the `else` branch that prints `'CWC server is not running.'`:

```ts
  } else {
    console.log(await describeIdleStop(PORT, { portInUse, resolveOccupant }))
  }
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: build completes; `dist/bin/cwc.js` and `dist/src/server/launcher.js` exist.

- [ ] **Step 6: Manual reproduction — the bug is gone**

Occupy 3579 with a non-CWC listener and run the built bin against an isolated HOME:

```bash
node -e "require('net').createServer().listen(3579,'127.0.0.1',()=>console.log('occupied 3579'))" &
OCC=$!
HOME="$(mktemp -d)" node dist/bin/cwc.js stop || true   # honest stop: names the occupant, not "not running"
HOME="$(mktemp -d)" node dist/bin/cwc.js < /dev/null; echo "exit=$?"
kill $OCC
```

Expected:
- `stop` prints `Port 3579 is held by a process CWC didn't start (PID …, node). … lsof -i:3579` — not "CWC server is not running."
- the start run prints the `Port 3579 is already in use …` conflict message, does **not** print `CWC server started`, and exits non-zero (`exit=1`).

- [ ] **Step 7: Full test suite**

Run: `npm test`
Expected: all tests pass (previous total + 14 new launcher tests).

- [ ] **Step 8: Commit**

```bash
git add bin/cwc.ts
git commit -m "fix(launcher): fail loud on port conflict instead of false success

npx claude-cwc no longer reports 'started' for a server that didn't bind.
Pre-flight probe reuses a healthy CWC server, restarts one we own, and fails
with an actionable message when a foreign process holds 3579. Spawned server
output is captured to ~/.cwc/logs and surfaced on startup failure; stop no
longer lies when a foreign process holds the port."
```

---

## Self-Review

**Spec coverage:**
- Pre-flight probe (cwc/foreign/free) → Task 1 (`probePortState`) + Task 3 (decision tree).
- Reuse healthy CWC / restart owned / fail loud on foreign / spawn on free → Task 3 (`startCwc`), verified by its 5 tests.
- Verify-after-spawn (success only after `/api/health` responds) → Task 3 (`waitForServer` gate) + Task 5 wiring (10 s default).
- Capture server output instead of `stdio:'ignore'` → Task 5 Step 3 (`stdio: ['ignore', out, err]` into `SERVICE_STDOUT/STDERR`) + Task 3 log-tail surfacing.
- Honest `stop` → Task 4 (`describeIdleStop`) + Task 5 Step 4 wiring.
- Foreign-occupant error message with best-effort PID → Task 2 (`resolveOccupant`) + Task 3 message builder.
- No port fallback / no `CWC_PORT` → enforced by Global Constraints; nothing in any task changes the port.
- Service branch + skill prompt unchanged → Task 5 explicitly leaves both intact.
- Testability refactor into `src/server/launcher.ts` with injected deps → Tasks 1–4.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions.

**Type consistency:** `PortState`, `Occupant`, `LsofRunner`, `StartResult`, `StartCtx` are defined once (Tasks 1–3) and consumed with matching names/signatures in later tasks and in the Task 5 wiring (`startCwc`, `describeIdleStop`, `probePortState`, `portInUse`, `serverResponding(PORT)`, `waitForServer(PORT, ms)`, `resolveOccupant`). The `io` shape `{ log, error }` matches between `StartCtx` and the bin wiring.
