import { describe, it, expect } from 'vitest'
import { SERVICE_LABEL, buildServerPlist } from '../../src/server/service-plist.js'

describe('buildServerPlist', () => {
  it('embeds label, node path, server entry, port, logs, env, and launch behavior', () => {
    const plist = buildServerPlist({
      nodePath: '/usr/bin/node',
      serverEntry: '/x/start.js',
      port: 3579,
      workingDirectory: '/Users/test',
      standardOutPath: '/Users/test/.cwc/logs/server.out.log',
      standardErrorPath: '/Users/test/.cwc/logs/server.err.log',
      environment: { HOME: '/Users/test', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin' },
      throttleInterval: 10,
    })
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(plist).toContain('<string>/usr/bin/node</string>')
    expect(plist).toContain('<string>/x/start.js</string>')
    expect(plist).toContain('<string>3579</string>')
    expect(plist).toContain('<key>WorkingDirectory</key>')
    expect(plist).toContain('<string>/Users/test</string>')
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<string>/Users/test/.cwc/logs/server.out.log</string>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
    expect(plist).toContain('<string>/Users/test/.cwc/logs/server.err.log</string>')
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).toContain('<key>PATH</key>')
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin</string>')
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist.startsWith('<?xml')).toBe(true)
  })

  it('escapes plist string values', () => {
    const plist = buildServerPlist({
      nodePath: '/tmp/node & friends/node',
      serverEntry: '/tmp/<cwc>/start "quoted".js',
      port: 3579,
      environment: { CWC_TEST: "a'b&c<d>" },
    })
    expect(plist).toContain('/tmp/node &amp; friends/node')
    expect(plist).toContain('/tmp/&lt;cwc&gt;/start &quot;quoted&quot;.js')
    expect(plist).toContain('a&apos;b&amp;c&lt;d&gt;')
  })
})
