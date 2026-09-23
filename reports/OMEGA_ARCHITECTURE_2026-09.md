# DOCTEUR — OMEGA V1 ARCHITECTURE (PHASE 1: AUDIT + ARCHITECTURE)

Date: 2026-09-22
Scope: Phase 1 only — threat model + architecture design. **No OMEGA code, no routes, no tables, no dependencies were added.** Per mission §1, this phase stops at the checkpoint and awaits explicit user validation before Phase 2 (Identity + Pairing + Crypto) begins.

---

## 1. What OMEGA is and is not

OMEGA is a visible, consented, revocable, auditable remote-administration module for devices the user owns or has been explicitly authorized to administer. It is not a RAT, not stealth surveillance, not a keylogger, not a generic remote shell, not a credential-theft tool, not a UAC/AV-evasion tool, and not a hidden-persistence mechanism. Every constraint below exists to keep that distinction structural — enforced by code, not by policy prose alone.

Three capability tiers, gated hierarchically but never assumed transitively permanent:

- **OMEGA_VIEW** — read-only remote screen visibility.
- **OMEGA_INTERACTIVE** — mouse/keyboard input injection, on top of VIEW.
- **OMEGA_ADMIN** — a closed enum of semantic system actions (lock screen, restart app, restart/shutdown device, get system info, get process summary), on top of INTERACTIVE. Never a shell. Never a `command: string` field anywhere in the API.

---

## 2. Threat model

For each threat: **Mitigation** (structural, in Phase 1 design) / **Limitation** (what remains a residual risk) / **Test** (how a later phase proves the mitigation holds).

### T1 — Remote device compromised (attacker controls a previously-legitimate paired device)
- **Mitigation**: permission levels are session-scoped, not device-permanent (§6/§22). A compromised device can only act within whatever level its *current* session was granted, and ADMIN-level actions require fresh confirmation rather than inheriting from a stale session (§22, §40).
- **Limitation**: if the device's private key itself is exfiltrated before compromise is detected, the attacker can complete pairing-equivalent authentication until the device is explicitly revoked. OMEGA cannot detect device-side compromise from the Docteur side alone.
- **Test**: Phase 2 — revoked-device reconnect attempt is rejected; Phase 5 — stolen-key simulation (valid key, unexpected behavior pattern) is out of scope for automated test (no behavioral anomaly detection in V1) but revocation-effectiveness is tested.

### T2 — Network hostile / MITM
- **Mitigation**: mutual authentication via device identity keys (§8), never a bearer-token-only scheme. Transport must be TLS-based (§8) so a network attacker cannot read or inject into an established session even on a compromised LAN segment.
- **Limitation**: initial pairing (§9/§10) is the one moment where a network attacker who also has physical/visual access to both screens simultaneously could theoretically intercept — mitigated by short-lived, single-use pairing codes and explicit identity confirmation on both sides (§11) rather than blind trust-on-first-use.
- **Test**: Phase 2 — MITM simulation against the pairing exchange (fake peer, wrong key) is rejected; Phase 2 — tampered/replayed session packets rejected.

### T3 — MITM (session-level, post-pairing)
- **Mitigation**: same as T2, transport-level (TLS/mTLS) after pairing establishes trust; session tokens are short-lived and bound to the authenticated device identity, not just a session ID.
- **Test**: Phase 2 — wrong-deviceId / wrong-sessionId packets rejected.

### T4 — Pairing code stolen (shoulder-surfed, screenshotted, intercepted)
- **Mitigation**: pairing code is short-lived (minutes, not hours), single-use, bound to one specific pairing attempt (not reusable across attempts), and rate-limited (§9/§52). A stolen code that isn't used before expiry is worthless; a stolen code that IS used still requires the human on Device A to see and explicitly ALLOW the exact incoming device identity (§11) — a stolen code alone does not complete pairing without that human confirmation step.
- **Limitation**: if the attacker steals the code AND completes the confirm step before the legitimate user notices (a race), pairing succeeds. This is inherent to any human-confirmed pairing scheme; the mitigation is keeping the window as short as practically usable (target: single-digit minutes) and rate-limiting confirmation attempts.
- **Test**: Phase 2 — expired pairing code rejected; reused pairing code rejected; brute-force attempt against the code space triggers cooldown (§52).

### T5 — Replay attacks
- **Mitigation**: every session has a unique sessionId + short-lived session key/token (§21), and OMEGA's approval hashes (mirroring MAÎTRE's `computeProposalHash`/`validateApproval` pattern — see §7 below) are re-derived from current state on every use, never trusted from a cached boolean. Pairing tokens are invalidated permanently the instant pairing completes (§10).
- **Test**: Phase 2 — replayed pairing token rejected; Phase 2 — replayed session token rejected; Phase 5 — replayed admin-action approval token rejected.

### T6 — Session hijacking
- **Mitigation**: session tokens are device-bound (not just a bearer secret — tied to the authenticated device identity established at pairing), short-lived, and revocable server-side at any time (§12/§58).
- **Test**: Phase 2 — session token presented by a device identity other than the one it was issued to is rejected.

### T7 — Privilege escalation (VIEW device attempting INTERACTIVE/ADMIN actions; INTERACTIVE device attempting ADMIN)
- **Mitigation**: permission level is checked server-side on every action, read from the session's granted level, never inferred from a client-supplied field (mirrors MAÎTRE's `ACTION_LEVELS` — server-side-fixed, client-supplied level values are ignored/rejected). §5/§6/§66/§67/§68 make this explicit per tier.
- **Test**: Phase 3 — VIEW session attempting input injection denied; Phase 4 — INTERACTIVE session attempting an admin action denied; Phase 5 — unknown/unlisted action type denied.

### T8 — Command injection / arbitrary shell injection
- **Mitigation**: structural, not policy — the ADMIN action API has a closed, server-defined enum (§38) and explicit prohibition on any `command`/`RUN_COMMAND`/`RUN_POWERSHELL`/`EXEC`/`EVAL`/`SHELL` action type or parameter shape (§37). The executor (Phase 5) will be built the same way MAÎTRE's `maitre-actions.js` is: each action type has its OWN typed parameter schema, there is no generic `{command: "..."}` shape anywhere, and forbidden parameter/target key names are checked generically across all action types regardless of type-specific schema (this is a verified existing MAÎTRE pattern, not aspirational).
- **Test**: Phase 5 — shell-shaped payloads (`powershell.exe`, `cmd.exe`, `bash`, `curl`, `wget`, `rm`, `del`, `taskkill`, `Start-Process`) submitted as action parameters are rejected at validation, never reach any execution path (§69).

### T9 — Stolen device (the controlling device, e.g. phone/laptop used to control the target, is stolen)
- **Mitigation**: same as T1 — session-scoped permissions, explicit revocation capability, ADMIN re-confirmation policy. A stolen controlling device only has whatever an attacker can do within Docteur's UI without the paired device owner's additional local confirmation for sensitive actions.
- **Limitation**: if the stolen device is unlocked and mid-session, standard "stolen unlocked device" risk applies — this is not OMEGA-specific and is not fully solvable by OMEGA alone (the emergency local stop on the CONTROLLED side, §59, is the actual backstop).
- **Test**: not independently testable beyond T1's revocation test; documented as a known limitation.

### T10 — Revoked device reconnecting
- **Mitigation**: revocation invalidates the pairing credential itself (§12), not just active sessions — a revoked device must complete a full new pairing flow, it cannot silently resume.
- **Test**: Phase 2 — revoked device attempting to start a session (with its old, still-cryptographically-valid-looking credential) is rejected.

### T11 — Malicious remote peer (a paired-and-authorized device behaves maliciously within its granted level)
- **Mitigation**: this is the residual risk any authorization system accepts once trust is granted — OMEGA's answer is keeping every granted level's *capability surface* as narrow as possible (no shell, no arbitrary file access in V1, closed admin-action enum) so "malicious within your granted level" has a small blast radius by construction, plus full audit logging (§45) so any misuse is visible after the fact even if not prevented in real time.
- **Test**: Phase 5 — every ADMIN action, even when validly authorized, is logged with full audit detail (§46).

### T12 — Malicious screen/control packet (crafted frame designed to exploit the receiving parser)
- **Mitigation**: bounded frame sizes, schema-validated message types, closed message-type allowlist (mirrors §40's worker-protocol allowlist idea from the Kiwix mission, applied here to OMEGA's own transport), malformed-input handling that fails closed (drop the frame / close the session) rather than attempting best-effort parsing.
- **Test**: Phase 3 — malformed frame, oversized frame, invalid message type all handled without crash (§28/§65).

### T13 — Oversized frames / resource exhaustion
- **Mitigation**: max resolution, max FPS, max bitrate, max message size, explicit backpressure (§26) so a fast producer (screen capture) cannot unboundedly queue against a slow consumer (network/receiver).
- **Test**: Phase 3 — oversized frame rejected; large-screen/high-resolution scenario bounded, not unbounded memory growth (§78 long-session soak test).

### T14 — Denial of service (against the local OMEGA control plane or the paired device)
- **Mitigation**: rate limiting on pairing attempts, session creation, auth failures, and admin requests (§51); bounded resource use per session (§77).
- **Limitation**: V1 has no distributed-DoS-scale defense — this is a single-user, authorized-device tool, not an internet-facing service, and the network architecture (§17, LAN-first) keeps exposure small by construction rather than by rate-limiting alone.
- **Test**: Phase 2 — brute-force pairing attempts trigger cooldown (§52).

### T15 — Credential exposure (private keys, session tokens, pairing codes exposed via logs, DB, or frontend)
- **Mitigation**: private keys never leave the owning machine (§8), never sent to frontend, never plaintext in SQLite (reuse `secret-store.js`'s DPAPI-backed storage — confirmed free-form `provider` parameter, an `omega:device:<deviceId>` namespace works with zero code changes to that module). Pino log redaction (§56) extended with OMEGA-specific field names (`pairingCode`, `sessionToken`, `privateKey`, `deviceKeyPem`) added to the existing shared `REDACT_PATHS` list in `logger.js` — the same single choke point every other module's secrets already go through, not a new parallel redaction system.
- **Test**: Phase 2 — grep test asserting no OMEGA secret material appears in log output across a full pairing+session lifecycle.

### T16 — Secret leakage in logs (distinct from T15: leakage via error messages, stack traces, or debug output rather than deliberate logging)
- **Mitigation**: same redaction mechanism as T15 covers this (Pino's `formatters.log` hook applies to all log calls including error objects, depth-bounded to 6 levels per the existing `deepRedact` implementation). OMEGA route handlers must never pass raw error objects containing secret material directly into a log call without going through the logger's normal path (no `console.log` bypass).
- **Test**: same as T15.

---

## 3. Trust model (§5/§6)

**Deny by default, at every layer:**

| State | Access |
|---|---|
| Unknown device (never paired) | 0 access |
| Paired but not authorized for a session | 0 control |
| Session granted OMEGA_VIEW | Screen read only — 0 input injection |
| Session granted OMEGA_INTERACTIVE | Screen + input — 0 admin actions |
| Session granted OMEGA_ADMIN | Screen + input + closed semantic-action enum only — 0 arbitrary command execution, ever |

Critically: **ADMIN is never assumed permanent.** A device's *pairing* establishes long-term cryptographic trust (§7); a *session's* permission level is granted per-session and, per §22, ADMIN-level re-authorization is preferred over automatic reconnect-and-restore, even for an already-trusted paired device. This mirrors MAÎTRE's own philosophy (Level 3 actions require "strengthened confirmation," never assumed from a prior approval) but is architecturally separate — OMEGA's approval state machine will be its own module (`omega-approval.js`, modeled on `maitre-approval.js`'s shape) with its own tables, never importing or calling into MAÎTRE's code, per mission §43.

---

## 4. Device identity (§7)

Each paired device gets:

```
deviceId       — stable, not derived from hostname/IP/MAC alone
publicKey      — the device's asymmetric public key, stored server-side
identityRef    — certificate/credential identity (see Crypto below)
createdAt
lastSeen
revokedAt      — null until revoked; once set, permanent for that identity
```

**Private key storage**: the private key never leaves the device that generated it. On the Docteur (controller) side, if Docteur itself needs to hold key material for ITS OWN identity (Docteur is also a device in this model — see §5 below), that private key is stored via `secret-store.js`'s existing DPAPI-backed `setSecret()`/`getSecret()` API, under a provider key namespaced `omega:device:<deviceId>` — confirmed to work with zero changes to that module, since its `provider` parameter is free-form with no hardcoded allowlist. No new DPAPI wrapper is introduced; OMEGA reuses Docteur's one existing secret-storage primitive.

---

## 5. Crypto (§8)

**No custom cryptography.** Standard, audited primitives only:

- **Transport**: TLS (modern, current cipher suites) for any network-level session channel.
- **Mutual authentication**: mTLS or an architecturally equivalent mutual-auth scheme (e.g., each side presents a certificate/public-key-bound identity derived at pairing time, verified on every session establishment — not just the initial pairing). The exact library choice (Node's built-in `tls`/`crypto` modules vs. a vetted higher-level library) is a Phase 2 implementation decision, not a Phase 1 architectural one — Phase 2 must document the specific library, its license, Windows support, and maintenance status before use, following the same dependency-vetting discipline already applied to `@vscode/ripgrep`/`jsdom`/etc. elsewhere in this codebase.
- **Key storage discipline**: private keys never in the frontend (confirmed: no OMEGA key material will ever be sent to `src/`), never in logs (§56/T15/T16), never plaintext in SQLite (DPAPI via `secret-store.js`, as above).

---

## 6. Pairing (§9/§10/§11)

- Pairing code: short-lived (target: single-digit minutes), single-use, bound to one specific pairing attempt, rate-limited. Never a permanent shared password, never a static code, never an indefinitely-reusable token.
- Flow: Device A starts pairing → Device B scans/enters the code → Device A displays the exact incoming device identity (name, OS, truncated deviceId, requested permission level, timestamp — §11) → user explicitly clicks ALLOW or DENY (no auto-accept) → both sides exchange public identities and derive/store trust → the pairing code is invalidated permanently, regardless of outcome.
- **UI requirement (§11)**: the confirmation screen must show enough real information that a user can actually make an informed decision — not just "a device wants to pair," but which device, what OS, what permission level is being requested, and when the request was made.

---

## 7. Permission model (§6, mirroring MAÎTRE's `ACTION_LEVELS` pattern)

```
OMEGA_VIEW        = 1   (screen read only)
OMEGA_INTERACTIVE = 2   (+ mouse/keyboard)
OMEGA_ADMIN       = 3   (+ closed semantic action enum)
```

Levels are hierarchical in capability (ADMIN implies INTERACTIVE implies VIEW) but **not** in trust duration — exactly like MAÎTRE's own `ACTION_LEVELS` object (Level 1/2/3, server-side-fixed, never client-chosen), a future OMEGA session's granted level is assigned server-side at session-creation time based on the device's authorized pairing level AND any additional per-session confirmation policy (§40), never accepted as a client-supplied field. ADMIN-level actions additionally go through their own hash-bound approval flow (see §9 below), separate from the session's base permission level — having an ADMIN-level session does not itself authorize a specific admin action without that action's own approval step.

---

## 8. Revocation (§12)

Revoking a device from Docteur must invalidate, immediately and irreversibly for that device identity:
- Future sessions (no new session can be created)
- The active session, if one exists, as close to immediately as the architecture allows
- The pairing credential itself (not just tokens derived from it)
- All outstanding session tokens for that device

A revoked device must complete a full new pairing flow to regain any access — there is no "re-authorize" shortcut that skips the human-confirmed pairing step.

---

## 9. Approval model for sensitive actions (§40, mirroring MAÎTRE's hash-bound pattern)

Confirmed via direct source review: `maitre-approval.js`/`maitre-actions.js` have **zero coupling to any executor** (there is no `maitre-executor.js` in the current codebase at all — the approval layer is pure proposal/policy/cryptographic-binding, by the file's own header comment). This makes it safe to structurally mirror without creating any accidental call path from OMEGA into MAÎTRE:

- `omega-approval.js` (Phase 5) will implement its own `createActionProposal` → `createApprovalRequest` → `validateApproval` → `approveProposal`/`rejectProposal` → `consumeApproval` state machine, with OMEGA's own SHA-256 proposal hash over `{deviceId, sessionId, actionType, parameters}` (the OMEGA-appropriate analog of MAÎTRE's `{incidentId, actionType, target, parameters}`), its own TTL (a Phase 5 decision — likely shorter than MAÎTRE's 5 minutes given the more direct blast radius of e.g. `SHUTDOWN_DEVICE`), and its own PENDING→APPROVED→CONSUMED state machine with hashes re-derived from current state on every validation call, never trusted from a cached boolean.
- This is a **separate identity domain** from MAÎTRE, per mission §43/§2 — OMEGA has its own tables (`omega_*` namespace), its own approval module, and no OMEGA permission ever becomes a MAÎTRE permission or vice versa.

---

## 10. Strict Local (§20)

| Path | Strict Local behavior |
|---|---|
| LAN-local session (direct, same network) | Allowed — explicitly permitted even under Strict Local, since it never leaves the local network |
| Internet relay | BLOCKED under Strict Local |
| Cloud signaling (e.g. NAT-traversal coordination service) | BLOCKED under Strict Local |
| Any cloud provider | BLOCKED under Strict Local |

Implementation: any OMEGA route that would traverse the Internet (relay/signaling) calls `assertCloudAllowed(c, message)` at its entry point — the exact same one-line idiom already used by `kiwix.js`, `research.js`, `voice.js`, `free-ai.js`, `image-router.js`, `teacher.js`. No automatic fallback to Internet relay if LAN-direct fails; if a session cannot be established LAN-direct and Internet relay is either disabled or blocked by Strict Local, the session fails closed with a clear error, never silently escalating to a less-local transport.

---

## 11. Network architecture (§17/§18/§19)

Three options audited, per mission's own instruction to prefer the smallest surface:

**A. LAN direct (preferred default for V1)**: controller and controlled device on the same local network, direct connection, no relay, no cloud dependency. Smallest surface, works fully offline/Strict-Local. This is the V1 default posture.

**B. Explicit user-configured remote relay**: only if the user explicitly configures and enables it. Must transport end-to-end encrypted data (or architecturally equivalent) so the relay itself cannot read session content — a relay is a transport waypoint, never a trusted party to the session's cryptographic identity. Strict Local blocks this entirely (§10 above).

**C. Direct Internet connection**: only "if technically justified" per mission §17 — V1 architecture does not commit to this without a specific, separately-justified design, since it has the largest attack surface (a listener reachable from the open Internet) of the three options and the mission's own instruction is to prefer the smallest surface.

**Decision for V1**: **Option A (LAN direct) is the only network path implemented in Phase 2/3/4/5 of this mission.** Options B and C remain documented as future extensions requiring their own dedicated architecture review before implementation — this avoids "opening a listener on 0.0.0.0 without necessity documented and protection forte" (§17's explicit prohibition), since LAN-direct with per-connection mutual auth is sufficient for the V1 use case (user controlling their own devices on their own network) and requires no new relay infrastructure, no new cloud dependency, and no new Strict-Local carve-out logic beyond what §10 already specifies.

**Discovery (§18)**: no aggressive network scanning, no full-subnet scan, no port sweep, no mass device fingerprinting. If any LAN discovery is offered, it is either explicit mDNS-style advertisement (opt-in, visible) or purely user-entered target address — never an automatic background scan.

---

## 12. Transport for screen/input (new precedent — no existing reusable pattern found)

Confirmed via codebase survey: **no WebSocket server exists anywhere in `cortex-server`** (no `ws` dependency, no WS route). The only existing real-time server-push pattern is Server-Sent Events via Hono's `ReadableStream` + `text/event-stream` (used by `download.js` and `kiwix.js` for progress streaming). SSE is one-directional (server→client), which fits screen-frame delivery (controller receives frames from the controlled device, relayed/proxied through Cortex per §76's "browser never talks directly to the peer" rule) but does not by itself carry the return channel for Phase 4's mouse/keyboard input.

**V1 architectural decision**: 
- Screen frames: server-push, either reusing the SSE `ReadableStream` idiom (simplest, proven pattern already in this codebase) or a purpose-built local channel if SSE's overhead/framing proves unsuitable for the required FPS/latency bounds (§26/§27) — this specific choice is deferred to Phase 3's own implementation checkpoint, which must document the decision and why, rather than being pre-committed here.
- Input events (Phase 4): discrete, individually-authenticated requests bound to the active session (each mouse-move/click/keypress is its own validated, bounded message on its own channel back to the controlled device) rather than a second open stream — this keeps the input path's message shape closed and schema-validated per-event (mirroring T12/T8's injection-prevention discipline) rather than introducing a second long-lived bidirectional channel whose framing would need the same level of scrutiny as the screen channel.
- Regardless of final transport choice, the **local control-plane routes** (session status, pairing, device management — everything that isn't the raw screen/input data path) follow `monitor.js`'s existing loopback-only guard pattern: `isLocal(c)` check + `Origin` header validated against `localhost`/`127.0.0.1`/`[::1]` only, confirmed as the established precedent for gating a sensitive local-machine-only control surface in this codebase.

---

## 13. No stealth (§14/§15/§16)

Structural, not just documented:
- No hidden tray/service/window designed to evade the user's awareness.
- No silent startup persistence in V1. If auto-launch is ever offered (future), it must be opt-in, visible in Settings, and easily disabled — never a hidden Registry Run key, scheduled task, or clandestine service.
- Portable/USB mode is explicitly out of scope for V1 (§16) — deferred to a separately-scoped V2 mission.
- The controlled machine always has a visible, permanent **"OMEGA — REMOTE SESSION ACTIVE"** indicator whenever a session is live (§13), showing remote device, permission level, and session duration, with a permanent, always-reachable **STOP SESSION** control.
- The controlled machine additionally has a **local-only emergency stop** (§59) — a mechanism that works entirely from the controlled machine itself (visible tray icon, local window, or a documented hotkey), with no remote override capable of disabling it. This is the backstop against T9 (stolen controlling device) and any scenario where the remote side cannot be trusted to self-report honestly.

---

## 14. Database (§47)

New tables, strictly namespaced `omega_*`, added to `sqlite.js` following the exact existing `database.exec(\`CREATE TABLE IF NOT EXISTS ...\`)` pattern (insertion point: immediately after the most recent schema block, currently `sales_drafts`'s index, before the `exec()` call's closing backtick) — **not created in this phase**, documented here for Phase 2 to implement:

```
omega_devices           — deviceId, publicKey, identityRef, createdAt, lastSeen, revokedAt
omega_pairings          — pairing attempt records, code (hashed, not plaintext), expiresAt, consumedAt, status
omega_sessions          — sessionId, deviceId, permissionLevel, createdAt, expiresAt, endedAt
omega_approvals         — mirrors maitre_approvals' shape: proposal hash, target hash, parameters hash, status, expiresAt
omega_audit             — event log (see §15 below)
```

No OMEGA table ever writes to `maitre_*`, `monitor_*`, or `cyber_*` tables (mission §44/§47), and no OMEGA code path ever reads Observateur's `monitor_*` tables for anything beyond optional read-only display (mission §44) — never a write.

---

## 15. Audit log (§45/§46)

Event types (closed enum, mirroring the mission's own list exactly):
```
PAIRING_STARTED, PAIRING_APPROVED, PAIRING_DENIED,
SESSION_STARTED, SESSION_STOPPED, PERMISSION_CHANGED, DEVICE_REVOKED,
VIEW_STARTED, INTERACTIVE_STARTED,
ADMIN_ACTION_REQUESTED, ADMIN_ACTION_APPROVED, ADMIN_ACTION_REJECTED, ADMIN_ACTION_COMPLETED
```

Each entry stores: `timestamp`, `deviceId`, `sessionId`, `action type`, `result`. Never stores: password, raw keyboard input, full screen frames, private key material, session secrets. This is enforced the same way as T15/T16 above — via the shared Pino redaction config in `logger.js`, extended with OMEGA-specific field names, rather than a bespoke per-module redaction scheme.

---

## 16. API surface (§48/§49/§50)

Control-plane (loopback/local, `monitor.js`-style guard):
```
GET    /api/omega/status
GET    /api/omega/devices
POST   /api/omega/pairing/start
POST   /api/omega/pairing/confirm
POST   /api/omega/devices/:id/revoke
POST   /api/omega/sessions
DELETE /api/omega/sessions/:id
GET    /api/omega/sessions/:id/status
```

Admin action endpoint (Phase 5 only):
```
POST /api/omega/sessions/:id/actions
Body: { actionType: ENUM, parameters: VALIDATED_SCHEMA }
```
Never `{ command: "..." }` — no such field exists anywhere in the OMEGA API surface, structurally, at any phase.

All routes follow the existing `createOmegaRoute({ services, logger })` Hono sub-app factory pattern, registered via `app.route('/api', createOmegaRoute({ services, logger }))` in `server.js` (insertion point: after the existing route-registration block, ~line 1746 in the current tree). Route guards reuse existing primitives: loopback/origin checks (`monitor.js` pattern), body-size bounds, schema validation, timeouts — the same discipline already applied across every other route module in this codebase. The remote session protocol (screen/input data path, once designed in Phase 3/4) requires its own strong authentication distinct from the local control-plane's loopback guard, since by definition it may be reached from another device on the LAN, not just `127.0.0.1`.

---

## 17. Rate limiting (§51/§52)

Limited and cooled down on repeated failure: pairing attempts, session creation, auth failures, admin action requests. Pairing codes specifically: sufficiently entropic, short expiry, rate-limited, and invalidated/cooled-down after N failed confirmation attempts — implementation detail (exact N, exact cooldown duration) deferred to Phase 2.

---

## 18. Device identity change / cloning (§53/§54)

After pairing, OMEGA trusts the device's cryptographic identity, never the original pairing code (which is single-use and immediately invalidated regardless). If a paired device's identity key ever changes, that is treated as `DEVICE_IDENTITY_CHANGED` and requires a full new pairing — never silently re-trusted. A cloned device database (same `deviceId`/metadata copied to a second machine) must not be able to silently impersonate the original if it does not also possess the original's private key material — since the private key never leaves the originating machine (§4/§5), a DB-only clone has the public identity record but not the ability to complete authenticated session establishment, which depends on proving possession of the private key, not just presenting the deviceId.

---

## 19. License / dependency gate (§76)

No dependency has been added in this phase. Phase 2's crypto/transport library choice must be vetted before adoption: license, maintenance activity, Windows support, security history, and actual necessity (vs. Node's built-in `crypto`/`tls` modules, which may be sufficient and require zero new dependency) — following the same discipline already applied throughout this codebase's dependency decisions (e.g. the Kiwix mission's BYO-binary decision, the Code Intelligence mission's reuse of `@vscode/ripgrep`). `npm audit fix`/`--force`/`--legacy-peer-deps` remain prohibited.

---

## DOCTEUR OMEGA ARCHITECTURE CHECKPOINT

Threat model : PASS (16 threats enumerated — remote compromise, network-hostile/MITM ×2, pairing-code theft, replay, session hijacking, privilege escalation, command injection, stolen controlling device, revoked-device reconnect, malicious authorized peer, malicious packet, oversized frames, DoS, credential exposure, log secret leakage — each with mitigation/limitation/test mapped to a specific future phase)

Transport selected : LAN direct (Option A) for V1; Internet relay (Option B) and direct-Internet (Option C) explicitly deferred, not implemented, pending separate future justification. Screen/input data-path transport mechanics (SSE-reuse vs. purpose-built channel) deferred to Phase 3's own checkpoint — no existing WebSocket precedent found in this codebase to reuse.

Identity model : Per-device asymmetric keypair; private key never leaves its owning machine, never in frontend, never in logs, never plaintext in SQLite (reused `secret-store.js` DPAPI-backed storage, confirmed free-form `provider` namespace — no new secret-storage module needed). Device record: deviceId, publicKey, identityRef, createdAt, lastSeen, revokedAt.

Pairing model : Short-lived, single-use, attempt-bound, rate-limited code; explicit human ALLOW/DENY on the confirming side with full visible identity detail (device name, OS, truncated deviceId, requested level, timestamp); code invalidated permanently on completion regardless of outcome.

Permission model : OMEGA_VIEW (1) / OMEGA_INTERACTIVE (2) / OMEGA_ADMIN (3), hierarchical in capability, server-side-assigned only (mirrors MAÎTRE's `ACTION_LEVELS` — never client-chosen), session-scoped rather than permanently inherited; ADMIN actions additionally require their own hash-bound approval (mirrors MAÎTRE's proposal/approval/consume state machine structurally, via a new, fully separate `omega-approval.js` — zero calls into MAÎTRE's code, confirmed safe since MAÎTRE's approval layer has zero executor coupling itself).

Revocation model : Immediate invalidation of future sessions, active session (best-effort immediate), pairing credential, and all outstanding session tokens; revoked device must complete full new pairing, no shortcut.

Strict Local model : LAN-direct sessions allowed under Strict Local; Internet relay, cloud signaling, and any cloud provider BLOCKED under Strict Local via the existing `assertCloudAllowed()` gate (same idiom as `kiwix.js`/`research.js`); no automatic fallback to a less-local transport if LAN-direct fails.

Stealth features : 0 planned (visible session indicator mandatory whenever active; local emergency stop mandatory on the controlled machine; no hidden tray/service/persistence in V1; portable/USB mode explicitly deferred to a separate V2 mission)

Arbitrary shell planned : 0 (closed semantic action enum only, mirroring MAÎTRE's own action-schema discipline: no `command: string` field anywhere in the API surface, at any phase, structurally)

Hidden persistence planned : 0 (V1 has no auto-launch at all; any future auto-launch would be opt-in, visible in Settings, easily disabled — never a hidden Registry Run key, scheduled task, or clandestine service)

Credential access planned : 0 (OMEGA has no scope to read, transmit, or store any credential belonging to MAÎTRE, secret-store's existing cloud-provider keys, or any other Docteur module; OMEGA's own device keys are the only secret material it manages, stored via the existing DPAPI-backed `secret-store.js`)

Architecture recommendation : Proceed to Phase 2 (Identity + Pairing + Crypto) only after explicit user validation of this document. Phase 2 must select and document the specific TLS/mTLS library (or confirm Node's built-in `crypto`/`tls` suffice), before any pairing code is written.

Files modified : 0 (this phase is architecture-only; only this report and its companion checkpoint were created under `reports/`)

Verdict : PASS

Then STOP.
