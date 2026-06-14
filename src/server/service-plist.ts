// src/server/service-plist.ts
export const SERVICE_LABEL = 'com.cwc.server'

export interface PlistOptions { nodePath: string; serverEntry: string; port: number }

/** Build a launchd user-agent plist that keeps the CWC server running at login. */
export function buildServerPlist(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodePath}</string>
    <string>${o.serverEntry}</string>
    <string>${o.port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
}
