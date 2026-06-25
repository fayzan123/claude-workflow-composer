import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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
