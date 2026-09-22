# DOCTEUR — CORTEX SERVER PORT 3001 / MAÎTRE 404 / EADDRINUSE FIX

Date: 2026-09-21

## Root cause

Two separate, compounding issues:

1. **Orphaned old backend instance.** PID 32780 (`node src/server.js`, started 16:27:45, launched via `npm start`) was left running from an earlier point in this development session — a build that predated the MAÎTRE routes being added to `server.js`. It was still bound to `127.0.0.1:3001`, healthy on `/api/ping`/`/api/health`, but returned 404 on every `/api/maitre/*` route because that code simply didn't exist in the running process's loaded module. Confirmed via live probe: `GET /api/maitre/overview` → 404, `/api/health` response missing the `maitre_routes` field this fix adds.

2. **No EADDRINUSE handling.** Any *new* cortex-server instance (correctly containing the current MAÎTRE routes, as proven by `MAITRE_ROUTE_REGISTERED` logging at route-construction time) crashed immediately on `serve()`'s underlying `http.Server` emitting an unhandled `'error'` event when the port was already taken — `@hono/node-server`'s `serve()` return value was never captured, so no `error` listener existed anywhere. Node's default behavior for an unhandled EventEmitter `'error'` event is to throw, producing the opaque crash the mission describes. The new instance's routes being correctly registered and then immediately dying meant the frontend kept talking to the old, route-less orphan the entire time.

## Process ownership investigation

Read-only investigation via `Get-NetTCPConnection` + `Get-CimInstance Win32_Process` (no `taskkill`/`Stop-Process`/wildcard kill used at any point during investigation):

| Field | Value |
|---|---|
| PID | 32780 |
| Executable | `C:\Program Files\nodejs\node.exe` |
| Command line | `node  src/server.js` |
| Parent PID | 16984 (`cmd.exe /d /s /c node src/server.js`) |
| Grandparent PID | 27632 (`npm-cli.js start`) |
| Working directory | `cortex-server/` (inferred: command line matches `cortex-server/package.json`'s `"start": "node src/server.js"` script exactly) |
| Start time | 2026-09-21 16:27:45 |

Verified against `cortex-server/package.json`: the `start` script (`node src/server.js`) matches this process's command line exactly, confirming it is a genuine — but outdated — cortex-server instance, not an unrelated process. Category per mission §4: **A (ancien processus orphelin)** — a legitimate earlier `npm start` invocation whose window/process was never closed when this session's work moved on to adding MAÎTRE routes.

## Startup workflow audit

Root `package.json`'s `dev` script only starts Vite — it never spawns cortex-server itself, so the two are always started independently.

Found four Windows batch launchers at the repo root:
- **`Docteur-Launcher.bat`** — already has a `:FREE_PORTS` helper: before starting Ollama/Cortex/frontend, it finds whatever PID is listening on ports 5173/3001 via `netstat -ano` and stops it by exact PID (never by process name or wildcard). This is a reasonable existing precedent, though it kills unconditionally (by port only, no ownership verification) rather than the identify-then-decide model this mission asks for.
- **`start-local.bat`** and **`start-mobile.bat`** — older, standalone launchers that do **not** call any port-cleanup step; they launch `cortex-server`'s `npm run dev:local` (or `dev:local` inside `Docteur-Launcher.bat`'s own menu option 2/3) directly into a new `cmd /k` window with no check for an existing instance.

This is the demonstrated duplicate-startup source (mission §3/§4, category **C: serveur lancé par un autre script**): running `start-local.bat` or `start-mobile.bat` while a Cortex Server window from an earlier `Docteur-Launcher.bat` session (or a manual `npm start`) is still open produces exactly this collision. No VS Code tasks, Electron/Tauri startup, or other orchestration exists — the .bat files are the only startup surface besides direct `npm start`/`npm run dev` invocation.

The server-side single-instance guard added by this fix (see below) makes this gap safe by construction going forward, without needing to touch all three .bat files individually: any second launch attempt, from any of the launchers or a manual terminal, now fails closed with a clear message instead of silently colliding.

## Fix

### 1. `cortex-server/src/server.js` — EADDRINUSE handling
`serve()`'s return value (the underlying `http.Server`/`https.Server`) is now captured into `httpServer`, with an `error` listener attached:
- `EADDRINUSE` → logs `CORTEX_PORT_IN_USE` with `{host, port}` (no secrets), then `process.exit(1)`.
- Any other listen error → logs the error message, then `process.exit(1)`.
- No fallback to any other port at any point — `env.PORT` (default 3001) is the only port ever attempted.

### 2. `cortex-server/src/lib/port-preflight.js` (new) — single-instance dev guard
Runs before `serve()` is called. Reuses MAÎTRE's existing `runReadOnlyPowerShell()` (fixed script text, `shell:false`, hard timeout, bounded output — the same already-audited execution path `maitre-defender-adapter.js`/`maitre-eventlog-adapter.js` use) to identify who, if anyone, holds `env.HOST:env.PORT`:

- **`free`** → proceeds to `serve()` normally.
- **`owned_by_cortex`** → the owning process's command line is checked for `src/server.js` (both the relative form `npm start`/`npm run dev` actually produce — e.g. `node  src/server.js` — and an absolute-path or nodemon-wrapped form), combined with a `node`/`nodemon` mention. Logs `CORTEX_ALREADY_RUNNING` with the PID, explains that an instance is already running and a second one is refused, `process.exit(1)`. **No kill of any kind.**
- **`owned_by_unknown`** → the owning process doesn't match the cortex-server entry point (e.g. a totally unrelated Node process, or anything else). Logs `CORTEX_PORT_OWNED_BY_UNKNOWN_PROCESS` with PID, process name, and full command line so the operator can identify and stop it manually. **Fails closed — `process.exit(1)`, no kill.**
- **`undetermined`** (non-Windows, or the PowerShell check itself fails) → does not block startup; the existing EADDRINUSE handler (item 1) still catches a real collision, just without the friendlier "who owns it" detail.

Deliberately does **not** trust process name alone (`ProcessName = node` is not sufficient per the mission's own instruction — this dev machine legitimately runs several unrelated `node.exe` processes, e.g. a SonarLint ESLint bridge, confirmed during investigation). Classification requires the command line to actually reference `src/server.js`.

Internally, the PowerShell probe script uses `ConvertTo-Json -Compress` rather than hand-built JSON strings — an early version that built JSON via string concatenation + `-replace` broke on Windows paths (unescaped backslashes in `ExecutablePath`/`CommandLine` produced invalid JSON, e.g. `\P`, `\n` interpreted as escape sequences), which was caught and fixed during live testing against the actual running instance (see Tests section).

### 3. `cortex-server/src/server.js` — health snapshot marker
`healthSnapshot()` (backing the existing `/api/health` route — reused, not reinvented, per mission §12) now includes:
- `maitre_routes: true` — a static marker (not a live probe) distinguishing any build that includes this field from an old build that doesn't.
- `pid: process.pid` — lets an operator immediately correlate which OS process answered a given `/api/health` call against `Get-NetTCPConnection`'s `OwningProcess`.

### 4. `src/lib/studio-errors.ts` — frontend error UX
Added one targeted mapping for Hono's own `app.notFound()` fallback body (`{ error: 'Route introuvable' }`) to: *"Backend MAÎTRE indisponible ou version serveur incompatible. Vérifiez qu'une seule instance de cortex-server est active, puis redémarrez-la."* — replacing the generic "Opération impossible" message specifically for this scenario (an old/wrong backend answering), without touching the broader error-mapping table or any other code path.

## Safety boundary

- No `taskkill /IM node.exe /F`, no `Stop-Process -Name node`, no wildcard/global kill, anywhere in the fix.
- No `shell:true` anywhere in the fix (both the new PowerShell invocation, via `runReadOnlyPowerShell`, and all `child_process` usage elsewhere in the touched files use `shell:false`/`execFile`).
- The one process actually stopped during this work (orphaned PID 32780) was stopped **manually via `Stop-Process -Id 32780`, by exact PID only, after independent re-verification of its command line immediately before the call, and only after explicit user confirmation** — not by any code path added in this fix. No code in this fix kills anything automatically, ever.
- `port-preflight.js` never falls back to a different port; `server.js`'s `EADDRINUSE` handler never falls back to a different port. `env.PORT` (3001 by default) remains the sole target.
- MAÎTRE's own files (`maitre-policy.js`, `maitre-actions.js`, `maitre-executor.js`, `maitre-host-isolation.js`, `maitre-evidence.js`, `maitre-models.js`) were not modified — `maitre-windows-exec.js` was only *imported* (read, not edited) by the new `port-preflight.js`, reusing its already-audited `runReadOnlyPowerShell`/`isWindows`/`toPsSingleQuotedLiteral` exports exactly as-is.

## Tests

New file `cortex-server/test-port-preflight.mjs` (8 tests, all passing), covering mission scenarios A–F:
- **A** (port free): `checkPortOwnership` on a genuinely free scratch port returns `state: 'free'`.
- **B** (recognized Cortex): validated live against the real running instance during manual testing (see Live Validation) — a second `node src/server.js` invocation correctly logs `CORTEX_ALREADY_RUNNING` and exits 1. The automated test suite covers the negative arm (a non-`src/server.js` Node process must never be misclassified as Cortex) directly, since the test runner's own process is not `src/server.js`.
- **C** (unknown process): a scratch `node:net` server bound to a throwaway port is correctly classified `owned_by_unknown` with PID surfaced, and is confirmed still listening (untouched) after the check.
- **D** (EADDRINUSE → exit non-zero): static assertion that `server.js`'s `httpServer.on('error', ...)` handler always calls `process.exit(1)`, never `process.exit(0)`. Exercised live (see below).
- **E** (no automatic port fallback): static source-text assertions that neither `port-preflight.js` nor `server.js`'s error handler references any neighboring port (3002/3003/`+1`) or the word "fallback" near "port".
- **F** (no global kill): static source-text assertions that `port-preflight.js` and `server.js`'s guard block contain no `taskkill`, `Stop-Process`, `child_process.kill`, `process.kill(`, or `shell:true`.

## Live validation

Performed against the real dev environment, in order:

1. Investigated and identified PID 32780 as the orphaned old backend (see Process ownership investigation above).
2. **User confirmed** stopping it; re-verified command line immediately before stopping; stopped by exact PID only.
3. Confirmed port 3001 free.
4. Started a fresh instance (`npm start`): log showed `MAITRE_ROUTE_REGISTERED` then `"cortex server started"` on `127.0.0.1:3001` — no crash.
5. Probed all 7 required routes plus health:

| Endpoint | Result |
|---|---|
| `GET /api/health` | 200, includes `"maitre_routes":true,"pid":15944` |
| `GET /api/maitre/overview` | **200** |
| `GET /api/maitre/incidents?limit=100` | **200** |
| `GET /api/maitre/events?limit=100` | **200** |
| `GET /api/maitre/processes` | **200** |
| `GET /api/maitre/persistence` | **200** |
| `GET /api/maitre/defender/status` | **200** |
| `GET /api/maitre/defender/detections` | **200** |

6. Attempted a second `node src/server.js` while the first was still running: exit code 1, log showed `MAITRE_ROUTE_REGISTERED` (routes still register in-memory before the port check fails, as expected) then `CORTEX_ALREADY_RUNNING` with the correct PID — no crash, no kill, no fallback.
7. Confirmed the first (real) instance was unaffected by the second-instance attempts (`/api/maitre/overview` still 200, health `pid` unchanged) throughout.
8. Also validated `checkPortOwnership`'s `owned_by_unknown` classification directly against a scratch `node:net` listener on an unrelated port, confirming it was left running (untouched) after the check.

## Regressions

- `node --test test-maitre-*.mjs` (cortex-server): **547/547 pass**.
- `scripts/test-maitre-studio-browser.mjs` (frontend + live backend): **27/27 pass**.
- `node --test test-port-preflight.mjs` (new): **8/8 pass**.
- `npx tsc --noEmit`: **PASS**, zero errors.
- `npm run build`: **PASS**.

## Known limitations

- `checkPortOwnership()`'s `owned_by_cortex` classification is Windows-only (`isWindows()` gate) — on a non-Windows platform it always returns `undetermined`, meaning the friendlier `CORTEX_ALREADY_RUNNING`/`CORTEX_PORT_OWNED_BY_UNKNOWN_PROCESS` messages won't fire there; the plain `CORTEX_PORT_IN_USE` EADDRINUSE handler still catches the collision either way, just without ownership detail. Docteur is Windows-first, so this was not extended to other platforms.
- The three older batch launchers (`start-local.bat`, `start-mobile.bat`, and `Docteur-Launcher.bat`'s blind `:FREE_PORTS` kill-by-port) were **not modified** — the server-side guard neutralizes the collision risk they created without needing per-script changes, and touching three separate `.bat` files was judged out of the minimal-fix scope for this mission. `Docteur-Launcher.bat`'s existing `:FREE_PORTS` still performs an unconditional kill-by-PID-from-netstat (no ownership check) before every launch; this pre-dates this fix and was left as-is since the mission's "do not touch unless a demonstrated bug" instruction didn't extend to files outside the reported symptom's direct call chain.
- The orphaned PID 32780 was stopped manually during this investigation, with explicit user confirmation — this fix does not (and per the mission, must not) automatically detect and stop such an orphan on its own; the new guard only prevents a *second* instance from being silently started next to an existing one going forward.

## Files changed

- `cortex-server/src/server.js` (modified — EADDRINUSE handling, single-instance preflight call, health marker)
- `cortex-server/src/lib/port-preflight.js` (new)
- `cortex-server/test-port-preflight.mjs` (new)
- `src/lib/studio-errors.ts` (modified — one new error-message mapping)

---

## CORTEX PORT 3001 / MAÎTRE FIX CHECKPOINT

Root cause : orphaned pre-MAÎTRE cortex-server instance (PID 32780) left running from earlier in the session, still bound to 3001; new instances correctly registered MAÎTRE routes but crashed unhandled on EADDRINUSE since `serve()`'s return value was never captured/listened-on.

Existing process on 3001 identified : YES

Was it Cortex : YES

Duplicate startup source : `start-local.bat`/`start-mobile.bat` lack the port-cleanup step `Docteur-Launcher.bat` already has, allowing a second launch to collide with an already-running instance — neutralized by the new server-side single-instance guard rather than by editing all three scripts.

Global Node kill added : 0

Unknown PID auto-kill : 0

Automatic port fallback : 0

Single-instance protection : PASS

Process lifecycle cleanup : NOT_NEEDED (no launcher-owned child-process lifecycle bug found; the orphan was a manually-started, manually-left-open process, not a leaked child of a launcher)

EADDRINUSE handling : PASS

MAÎTRE route registration : PASS

GET /api/maitre/overview : PASS

GET /api/maitre/incidents : PASS

GET /api/maitre/events : PASS

GET /api/maitre/processes : PASS

GET /api/maitre/persistence : PASS

GET /api/maitre/defender/status : PASS

GET /api/maitre/defender/detections : PASS

Frontend MAÎTRE state : PASS

MAÎTRE backend tests : 547/547

MAÎTRE browser tests : 27/27

Typecheck : PASS

Build : PASS

Files changed : cortex-server/src/server.js, cortex-server/src/lib/port-preflight.js (new), cortex-server/test-port-preflight.mjs (new), src/lib/studio-errors.ts

Known limitations : ownership classification is Windows-only (falls back to plain EADDRINUSE handling elsewhere); older batch launchers not individually hardened (neutralized instead by the server-side guard); no automatic orphan detection/cleanup (by design — never auto-kill).

Verdict : PASS

Puis STOP.
