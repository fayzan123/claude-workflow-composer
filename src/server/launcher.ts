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
