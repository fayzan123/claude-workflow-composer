import { describe, it, expect } from 'vitest'
import { SERVICE_LABEL, buildServerPlist } from '../../src/server/service-plist.js'

describe('buildServerPlist', () => {
  it('embeds label, node path, server entry, and port; sets RunAtLoad + KeepAlive', () => {
    const plist = buildServerPlist({ nodePath: '/usr/bin/node', serverEntry: '/x/start.js', port: 3579 })
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(plist).toContain('<string>/usr/bin/node</string>')
    expect(plist).toContain('<string>/x/start.js</string>')
    expect(plist).toContain('<string>3579</string>')
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist.startsWith('<?xml')).toBe(true)
  })
})
