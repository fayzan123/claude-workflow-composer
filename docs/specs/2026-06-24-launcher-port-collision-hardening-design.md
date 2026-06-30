# Launcher port-collision hardening (Case 2)

**Date:** 2026-06-24
**Status:** Design approved, ready for implementation plan
**Scope:** `bin/cwc.ts` launcher behavior when port 3579 cannot be bound on startup.

## Problem

When `npx claude-cwc` starts the server, `startServer()` in `bin/cwc.ts` spawns the
server **detached with `stdio: 'ignore'`**, then — after a blind 800 ms wait —
unconditionally prints `CWC server started (PID x)` and opens the browser.

If the server fails to bind port 3579, the spawned child crashes immediately. But
because its output is discarded and the parent never checks whether it came up, the
user sees a confident success message and a browser tab pointed at a server that
isn't there (or, worse, at whatever *other* app happens to occupy 3579). The server
itself prints a useful diagnostic — `Port 3579 is already in use. Run 'npx claude-cwc
stop' to kill the existing server.` (`src/server/index.ts:180`) — but the launcher
throws it away.

Reproduced against published `claude-cwc@0.11.4`: with 3579 occupied, the real bin
printed `CWC server started (PID 54324)` for a process that was already dead.

Three compounding defects:

1. **False success.** The launcher reports "started" without verifying the server
   responds.
2. **Swallowed diagnostics.** `stdio: 'ignore'` discards the server's own error
   message, leaving the user with nothing to act on.
3. **`stop` lies.** When a *foreign* (non-CWC) process holds 3579, `stopServer()`
   finds no PID file and prints `CWC server is not running` — false, and the
   suggested remedy does nothing.

### Why not just use a different port?

Auto-fallback to another port is **rejected**. Port 3579 is hardcoded into artifacts
that escape the server's control:

- `src/prose-generator.ts:243` — every exported workflow skill bakes
  `http://localhost:3579/api/runs/events` into its run-logging curl. A different port
  silently breaks run observability for all exported workflows (the curl ends in
  `|| true`).
- `client/src/components/automate/AutomationModal.tsx` and `AutomateMode.tsx` display
  `http://localhost:3579/api/triggers/...` to the user as copy-paste webhook URLs.

3579 stays canonical. The fix is to **never fail silently on 3579**, not to move off it.

A `CWC_PORT` override is also **out of scope** for the same reason — exports assume
3579, so a user-set port is a footgun ("I set CWC_PORT and my workflows stopped
logging"). It can be added later behind an explicit warning if a real need appears.

## Goals

- The launcher must never report success for a server that did not come up.
- A foreign process on 3579 produces a clear, actionable error and a non-zero exit —
  not a spawned, doomed child and not a misleading browser tab.
- An already-running CWC server is reused (or, when we own it, restarted to pick up a
  new version) rather than duplicated.
- The server's own startup diagnostics reach the user when startup fails.
- `stop` tells the truth when a foreign process holds the port.

## Non-goals

- Auto port fallback (see above).
- `CWC_PORT` / configurable port (see above).
- Changing the launchd service path (`isServiceInstalled()` branch) — it already
  verifies readiness via `serverResponding()` and logs to files. Left unchanged.
- Changing the skill-install prompt (`maybeManageSkill`) — separate concern.

## Design

### Port state probe

Add a probe that classifies port 3579 into one of three states, built from the
existing `serverResponding()` helper plus a new TCP connect check:

```
probePortState(port) -> 'cwc' | 'foreign' | 'free'
  - serverResponding(port) true                  -> 'cwc'     (a healthy CWC server)
  - else portInUse(port) (TCP connect succeeds)  -> 'foreign' (something else holds it)
  - else                                         -> 'free'
```

- `serverResponding()` already exists: GET `/api/health`, requires
  `status === 200` and body containing `"status":"ok"`. Reused unchanged.
- `portInUse(port)`: `net.connect` to `127.0.0.1:port` with a short timeout
  (~500 ms). Connection established → in use; `ECONNREFUSED` → free; timeout →
  treat as in use (conservative — better to fail loud than spawn into ambiguity).

### Start decision tree (replaces the non-service path of `startServer()`)

The launchd-service branch (`isServiceInstalled()`) is unchanged. The PID/spawn path
becomes:

1. **We own a live server** — a PID file exists and `isRunning(pid)`:
   restart it (SIGTERM, wait, remove PID file) so a re-run picks up a newly installed
   version, then continue to step 3 (spawn + verify). *(Preserves today's
   restart-on-rerun behavior.)*

2. **No live PID file** — probe the port:
   - `'cwc'` → a CWC server is already up that this command did not start (a dev
     server, or a server whose PID file was lost). **Do not spawn a duplicate.** Print
     `CWC is already running at http://localhost:3579` and open the browser. Done.
   - `'foreign'` → **fail loud.** Print the actionable error (below) and exit 1. Do
     not spawn.
   - `'free'` → continue to step 3.

3. **Spawn + verify.** Spawn the server detached, redirecting stdout/stderr to the log
   files (below), `writePid`, then `waitForServer(timeoutMs)` (~10 s) polling
   `/api/health`:
   - responds → print `CWC server started (PID x) at http://localhost:3579` and open
     the browser. *(Success message now comes only after verification.)*
   - never responds → read the tail of the server error log, print it with guidance,
     remove the stale PID file, and exit 1.

### Capture server output instead of discarding it

Change the spawn `stdio` from `'ignore'` to redirect into the existing service log
paths so failures are diagnosable:

```
mkdir -p SERVICE_LOG_DIR
const out = fs.openSync(SERVICE_STDOUT, 'a')   // ~/.cwc/logs/server.out.log
const err = fs.openSync(SERVICE_STDERR, 'a')   // ~/.cwc/logs/server.err.log
spawn(node, [serverEntry, PORT], { detached: true, stdio: ['ignore', out, err] })
child.unref()
```

`SERVICE_STDOUT` / `SERVICE_STDERR` / `SERVICE_LOG_DIR` already exist as constants
(used by the launchd path). The manual-spawn path and the service path never run
simultaneously (the service branch returns early), so they never contend for the
files. On a failed `waitForServer`, the bin tails `SERVICE_STDERR` (last ~10 lines)
into its own error output, surfacing the server's `Port 3579 is already in use…`
message.

### Honest `stop`

In `stopServer()`, after the service and PID-file checks fall through to "not
running", probe the port. If `portInUse(PORT)` is true, report the truth instead of
`CWC server is not running`:

```
Port 3579 is held by a process CWC didn't start (PID <pid>, <command>).
CWC isn't managing it. Inspect it with: lsof -i:3579
```

PID/command are resolved best-effort via `lsof -nP -iTCP:3579 -sTCP:LISTEN`; if `lsof`
is unavailable or returns nothing (e.g. Windows), omit the PID detail and print the
generic form. Never throws on a missing `lsof`.

### Error message (foreign occupant)

Used by both the start pre-flight and the failed-verify path:

```
Port 3579 is already in use by another process that CWC didn't start
(PID <pid>, <command>). CWC requires port 3579 and cannot use a different one.
Free it — find it with `lsof -i:3579`, then stop that process — and re-run
`npx claude-cwc`. If you started CWC another way, `npx claude-cwc stop` may help.
```

`<pid>, <command>` included when `lsof` resolves them; omitted gracefully otherwise.

## Structure / testability

`bin/cwc.ts` is currently an untestable top-level script. Extract the
server-management logic into a new testable module **`src/server/launcher.ts`** that
`bin/cwc.ts` imports. Moved/added:

- Helpers: `serverResponding`, `waitForServer`, `portInUse` (new),
  `probePortState` (new), `readPid`, `writePid`, `isRunning`, `isServiceInstalled`,
  `launchctl`.
- `startCwc(deps)` — the decision tree above.
- `stopCwc(deps)` — including the honest-stop probe.
- `resolvePortOccupant(port)` (new) — best-effort `lsof` → `{ pid, command } | null`.

Each entrypoint function accepts an injectable `deps` object (probe, spawn, open,
fs, clock, lsof runner) defaulting to the real implementations — matching the repo's
existing "inject, don't mock" convention (cf. `AppOptions` in `src/server/index.ts`).
`installService` / `uninstallService` and skill management stay in `bin/cwc.ts` for
now (out of scope), importing the shared helpers from `launcher.ts`.

`bin/cwc.ts` becomes a thin entrypoint: parse argv → skill management (unchanged) →
delegate to `launcher` functions.

## Testing

New `tests/server/launcher.test.ts`, real filesystems + real sockets (no mocks),
following the existing test style:

1. **`portInUse`** — false for a free ephemeral port; true while a real `net.Server`
   listens on it.
2. **`probePortState`** — `'free'` for an unused port; `'foreign'` for a plain
   `net.Server` that isn't CWC; `'cwc'` for a stub HTTP server returning
   `{"status":"ok"}` on `/api/health`.
3. **Foreign occupant → loud failure.** With a non-CWC listener on the test port,
   `startCwc` (injected deps) exits with the actionable message, calls `open` zero
   times, and never invokes the injected `spawn`. Asserts no false "started".
4. **Free port → spawn + verify success.** Injected `spawn` + a fake server that
   becomes healthy; `startCwc` prints success only after `waitForServer` resolves and
   opens the browser once.
5. **Spawn but never healthy → surfaced error.** Injected `spawn` whose process never
   responds; `startCwc` reads the err-log tail, prints it, removes the PID file, and
   exits non-zero without opening the browser.
6. **Already-running CWC (no owned PID) → reuse.** Health responds, no live PID file;
   `startCwc` opens the browser, prints "already running", and does not spawn.
7. **Honest stop.** No service, no live PID, port occupied by a foreign listener →
   `stopCwc` reports the foreign-occupant message, not "not running".

`resolvePortOccupant` / `lsof` parsing tested with a fake runner returning canned
`lsof` output, plus a path where the runner errors (→ returns `null`, no throw).

## Risks / edge cases

- **Concurrent `npx` runs** racing for 3579: both may see `'free'`, both spawn, one
  wins the bind. The loser's child crashes; with verify-after-spawn both still observe
  a healthy server (the winner's) and may both report success, and the loser overwrites
  the PID file with a dead PID. Honest-stop handles the resulting stale PID. Treated as
  best-effort; not hardened further.
- **Lost PID file but old server still healthy**: classified `'cwc'` → reused rather
  than restarted, so a version bump may not take effect until the old server is stopped.
  Acceptable and strictly safer than spawning a doomed duplicate; documented behavior.
- **`lsof` absent** (Windows, minimal environments): PID detail omitted, generic
  message shown. Never fatal.

## Out of scope (tracked elsewhere)

- README "Prerequisites" section + honest Node/`claude`-CLI requirements.
- Startup gate checking the `claude` binary (not just `~/.claude/`).
- Native `curl | sh` installer (the larger "true one-liner" effort).
- Generation-engine quality (the separately-identified larger funnel leak).
