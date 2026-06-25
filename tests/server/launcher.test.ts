import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as net from 'node:net'
import * as http from 'node:http'
import { portInUse, serverResponding, probePortState, waitForServer } from '../../src/server/launcher.js'
import { resolveOccupant } from '../../src/server/launcher.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startCwc, type StartCtx } from '../../src/server/launcher.js'

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
    const conns = new Set<net.Socket>()
    s.on('connection', (c) => { conns.add(c); c.on('close', () => conns.delete(c)) })
    openSockets.push({ close: (cb: () => void) => { conns.forEach((c) => c.destroy()); s.close(cb) } } as unknown as net.Server)
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
