# DOCTEUR OMEGA PHASE 4.1 — HARDENING VIEW + INTERACTIVE

Date: 2026-09-22  
Scope: TLS transport hardening, persistent local indicator, lifecycle cleanup and regression validation. Phase 5 was not started.

## Verdict

**PASS for the Phase 4.1 scope.** Remote OMEGA VIEW and INTERACTIVE traffic is accepted only over TLS; loopback HTTP remains available for local Cortex use. When LAN mode is enabled without both certificate files, Cortex now refuses startup instead of silently binding cleartext `0.0.0.0`.

## Existing server and TLS audit

- OMEGA remains registered on Cortex's existing listener and existing port (`PORT`, normally `3001`). No new listener, relay, tunnel or fallback port was added.
- Default mode remains `HOST=127.0.0.1`, HTTP, with OMEGA loopback requests allowed.
- `LOCAL_NETWORK=true` keeps the existing LAN bind (`0.0.0.0`) but now requires `certs/key.pem` and `certs/cert.pem`; otherwise startup fails closed.
- With both files present, the existing listener is created with `https.createServer({ key, cert })`. The certificate is generated only by the existing explicit `scripts/gen-cert.mjs` flow; no trust-store installation, elevation or automatic certificate acceptance was added.
- The health response exposes only the public SHA-256 certificate fingerprint via `crypto.X509Certificate`. The private key is never returned, logged or written to the report.
- Forwarded headers are ignored. The transport decision uses the actual Node socket: loopback HTTP is allowed; any non-loopback request must have `socket.encrypted === true`.
- The OMEGA routes return `403 {"error":"OMEGA_TLS_REQUIRED"}` before session authentication for remote cleartext requests. TLS does not replace the existing device identity, permission, expiry, nonce/replay or revocation checks.

## Persistent indicator

`src/lib/omega-indicator.js` and `src/lib/omega-indicator.ps1` now implement one visible WinForms window/process per active session on Windows:

- VIEW title: `OMEGA — VIEW ONLY ACTIVE`.
- INTERACTIVE title: `OMEGA — INTERACTIVE CONTROL ACTIVE`.
- The window is always on top, appears in the taskbar and contains a local `STOP OMEGA SESSION` button.
- VIEW explicitly says that mouse and keyboard control are disabled; INTERACTIVE explicitly says that mouse and keyboard control are active.
- The process receives only fixed enum mode arguments, absolute repository script paths and per-session lease/stop paths. No device name, token, HTML or caller text is interpolated.
- Cortex refreshes the lease every second. The indicator exits after five seconds without a heartbeat, covering crash and restart cleanup.
- Session expiry schedules exact cleanup. Remote STOP, local STOP, device revocation and test cleanup terminate only the exact process owned by the matching session/device. There is no global process-name kill and no remote hide endpoint.
- The local STOP file invokes the existing session-stop callback, so the server ends the session and records the normal lifecycle audit rather than merely hiding the window.
- There is no service, driver, hook, scheduled task, registry Run/RunOnce entry, startup entry, auto-start or hidden persistence.

## Tests

Phase 4.1 hardening coverage:

| Test | Tests | Pass | Fail | Cancelled | Skipped |
|---|---:|---:|---:|---:|---:|
| `test-omega-hardening.mjs` | 6 | 6 | 0 | 0 | 0 |
| `test-omega-security.mjs` | 6 | 6 | 0 | 0 | 0 |
| `test-strict-local-centralized.mjs` | 13 | 13 | 0 | 0 | 0 |
| `test-phase1-egress-certification.mjs` | 7 | 7 | 0 | 0 | 0 |

All OMEGA files (`test-omega-*.mjs`): **206 tests, 203 pass, 0 fail, 0 cancelled, 3 skipped**. The three skips remain the pre-existing opt-in/non-default real-input cases.

Full backend regression, run file by file with `node --test --test-timeout=20000` outside the restricted sandbox so Windows DPAPI and desktop APIs were available:

- 131 files;
- 2153 tests;
- 2144 pass;
- 3 fail;
- 3 cancelled;
- 3 skipped.

The six known baseline non-passers are unchanged and outside Phase 4.1:

- `test-cyber-audit-crawler.mjs`: 1 cancelled;
- `test-find-eval.mjs`: 1 fail;
- `test-maitre-executor-level2.mjs`: 1 cancelled;
- `test-regression-api.mjs`: 1 cancelled;
- `test-video-manual.mjs`: 1 fail;
- `test-video-pipeline.mjs`: 1 fail.

Additional checks:

- `node --check` for all changed JavaScript modules: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS; existing large-chunk warning only.
- Server boot: PASS on the existing `127.0.0.1:3001` HTTP listener. `/api/health` returned the expected environment-dependent `503` because Ollama was unavailable; the OMEGA route was reached and rejected invalid input with `400`. The smoke server was stopped afterward.
- The strict-local and egress tests performed no cloud call.

## Security boundaries retained

VIEW remains structurally separate from input injection. INTERACTIVE still uses the existing allowlists, bounds, rate limits, session permissions, nonce chain, device binding, revocation and UIPI boundary. There is no clipboard, file transfer, arbitrary shell, elevation, secure-desktop bypass, cloud relay or admin action path in the OMEGA additions.

The certificate remains user-managed; a client must validate/trust the configured certificate according to its local policy. OMEGA does not silently install trust or claim mTLS/certificate pinning. Remote cleartext is denied rather than treated as secure.

## DOCTEUR OMEGA HARDENING 4.1 CHECKPOINT

Remote VIEW over cleartext: **DENY**  
Remote INTERACTIVE over cleartext: **DENY**  
Remote VIEW/INTERACTIVE over TLS: **ALLOW, then existing auth/session gates**  
Loopback HTTP: **ALLOW**  
LAN startup without TLS certificate: **REFUSE**  
Existing listener/port only: **PASS**  
Persistent VIEW indicator: **PASS**  
Persistent INTERACTIVE indicator: **PASS**  
Local STOP: **PASS**  
Expiry/crash/restart cleanup: **PASS**  
Device revocation cleanup: **PASS**  
Remote hide API: **0**  
Hidden persistence/autostart: **0**  
Private key exposure: **0**  
OMEGA hardening tests: **6/6**  
OMEGA aggregate: **203/206, skipped 3**  
Relevant regressions: **PASS**  
Full backend regression: **PARTIAL — known baseline six files only**  
Typecheck: **PASS**  
Build: **PASS**  
Server boot: **PASS**  

**Phase 4.1 complete. STOP. No Phase 5 started.**
