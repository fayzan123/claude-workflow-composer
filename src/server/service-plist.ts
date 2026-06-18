// src/server/service-plist.ts
export const SERVICE_LABEL = 'com.cwc.server'

export interface PlistOptions {
  nodePath: string
  serverEntry: string
  port: number
  workingDirectory?: string
  standardOutPath?: string
  standardErrorPath?: string
  environment?: Record<string, string>
  throttleInterval?: number
}

function escapePlistString(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stringEntry(value: string): string {
  return `  <string>${escapePlistString(value)}</string>`
}

function optionalStringKey(key: string, value: string | undefined): string {
  return value ? `  <key>${key}</key>\n${stringEntry(value)}\n` : ''
}

function environmentBlock(environment: Record<string, string> | undefined): string {
  const entries = Object.entries(environment ?? {}).filter(([, value]) => value.length > 0)
  if (entries.length === 0) return ''
  return `  <key>EnvironmentVariables</key>
  <dict>
${entries.map(([key, value]) => `    <key>${escapePlistString(key)}</key>\n    <string>${escapePlistString(value)}</string>`).join('\n')}
  </dict>
`
}

/** Build a launchd user-agent plist that keeps the CWC server running at login. */
export function buildServerPlist(o: PlistOptions): string {
  const requestedThrottle = o.throttleInterval
  const throttle = typeof requestedThrottle === 'number' && Number.isFinite(requestedThrottle) && requestedThrottle > 0
    ? Math.floor(requestedThrottle)
    : 10
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${stringEntry(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
${stringEntry(o.nodePath).replace(/^/gm, '  ')}
${stringEntry(o.serverEntry).replace(/^/gm, '  ')}
${stringEntry(String(o.port)).replace(/^/gm, '  ')}
  </array>
${optionalStringKey('WorkingDirectory', o.workingDirectory)}${optionalStringKey('StandardOutPath', o.standardOutPath)}${optionalStringKey('StandardErrorPath', o.standardErrorPath)}${environmentBlock(o.environment)}  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
}
