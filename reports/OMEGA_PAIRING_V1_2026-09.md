# DOCTEUR — OMEGA V1 PAIRING (PHASE 2: IDENTITY + PAIRING + CRYPTO)

Date: 2026-09-22
Scope: Phase 2 only — device cryptographic identity, secure private-key storage, short-lived single-use pairing, mutual authentication (challenge-response), revocation, short-lived session tokens, anti-replay, audit logging. Per Phase 1's architecture (already validated), this phase adds **zero** screen capture, mouse/keyboard injection, ADMIN actions, shell, Windows service, persistence, or Internet relay.

---

## 1. Crypto selection (mission §1/§2/§5)

**Decision: Node's built-in `crypto` module only — no third-party dependency added.**

Audited before writing any code: Node's `crypto.generateKeyPairSync`, `crypto.sign`/`crypto.verify`, `crypto.randomBytes`/`crypto.randomInt`, `crypto.timingSafeEqual`, `crypto.createHash`, `crypto.createPublicKey`/`createPrivateKey` were checked against every need in this phase's scope (key generation, signing, verification, hashing, random generation, timing-safe comparison) and found fully sufficient. No TLS/mTLS library was evaluated for adoption because Phase 2's mutual-auth requirement is satisfied by challenge-response signatures (see §5 below) rather than a live socket — there was nothing left that Node's own `crypto`/`tls` modules could not do, so per the mission's own instruction ("ne pas ajouter une dépendance crypto simplement pour simplifier quelques lignes"), none was added.

**Algorithm: Ed25519 (EdDSA over Curve25519)**, via `crypto.generateKeyPairSync('ed25519')`.

Why:
- Modern, small (32-byte public key, 64-byte signature), fast.
- Constant-time by design — no variable-time scalar-multiplication timing side channel the way naive ECDSA implementations can have.
- Natively supported by Node/OpenSSL with zero extra curve-parameter configuration.
- Appropriate for signing short messages (pairing/session challenge proofs), which is exactly this phase's use case — not bulk encryption.
- Verified locally before use: `generateKeyPairSync('ed25519')` → export SPKI/PKCS8 PEM → `crypto.sign(null, msg, privateKey)` → `crypto.verify(null, msg, publicKey, sig)` round-trips correctly on this machine's Node v22.22.3.

**Fingerprint**: SHA-256 of the SPKI-DER-encoded public key, hex-encoded (`omega-identity.js::computeFingerprint`).

**Pairing code hashing**: SHA-256 over the raw code bytes, stored as the only at-rest representation (never the plaintext code). A slow KDF (scrypt/bcrypt) was considered and explicitly rejected — documented rationale in `omega-pairing.js`'s header comment: the pairing code is not a low-entropy human password, it's a machine-generated 8-character/32-symbol code (~40 bits of entropy) that expires in 3 minutes and is attempt-capped at 5 tries, so a slow KDF's threat model (slowing offline brute force of a low-entropy secret) doesn't apply the same way, while SHA-256 keeps the legitimate high-frequency verify() path cheap. Comparison uses `crypto.timingSafeEqual`.

**Custom cryptography: 0.** No custom algorithm, no custom encryption, no custom signature scheme, no improvised key derivation, no weak-random-only token, no plaintext private-key storage anywhere in this phase's code.

---

## 2. Identity model (mission §3/§4)

Each device record (`omega_devices` table) holds: `id`, `display_name`, `public_key_pem`, `fingerprint`, `permission_level`, `created_at`, `last_seen`, `revoked_at`.

The **private key never leaves the module that generates it** (`omega-identity.js`):
- Never returned to a route handler as a value.
- Never included in any API response body (confirmed by dedicated tests — see §7).
- Never logged (OMEGA-specific field names added to the shared Pino `REDACT_PATHS` in `logger.js` — see §6).
- Never written to SQLite in plaintext — SQLite only ever holds the **public** key.

`display_name` and all audit-log strings are treated as untrusted input (mission §29): stored and returned verbatim as inert JSON text, never interpreted, never used to build HTML/SQL/shell strings. Verified with `<script>`, `<img onerror>`, and `javascript:`-shaped payloads through the full HTTP round trip.

---

## 3. Private key storage (mission §4)

Reuses `secret-store.js`'s existing DPAPI-backed (`ProtectedData`, Windows CurrentUser scope) `setSecret()`/`getSecret()`/`getSecretStatus()`/`deleteSecret()` API **verbatim — zero changes to that file**, under the namespace prefix **`omega-device-key:<deviceId>`** (exact prefix from this mission's own §4), distinct from any cloud-provider namespace.

Tested (in `test-omega-identity.mjs` and `test-omega-security.mjs`):
- **Store + retrieve**: generate → sign → verify round-trips correctly.
- **Corrupted blob**: a garbage ciphertext written directly for a never-before-decrypted provider key reports `getSecretStatus() === 'invalid'`, and `signWithDeviceKey()` throws a clean `device_key_corrupted`/`device_key_unavailable` error rather than crashing.
- **Missing key**: `getSecretStatus()` reports `'absent'` for a device that was never generated; `signWithDeviceKey()` throws `device_key_unavailable`.
- **Wrong-user/wrong-machine** behavior is inherited directly from `secret-store.js`'s existing DPAPI semantics (decrypt failure → `'invalid'` status) — not re-implemented, just relied upon.
- **Cloned DB without the private key**: a device record (public key, fingerprint, deviceId — all non-secret) copied elsewhere cannot forge a valid signature; verification against the real registered public key fails for any signature not produced by the real private key.

---

## 4. Pairing protocol (mission §6/§7/§8/§9/§10/§11)

State machine (`omega_pairings` table): `PENDING → AWAITING_APPROVAL → APPROVED/DENIED`, plus `EXPIRED` (time-based) and implicit `CONSUMED` semantics (an `APPROVED`/`DENIED` pairing can never be re-verified or re-approved).

- **Code generation**: `crypto.randomInt` over a 30-symbol Crockford-style alphabet (excludes ambiguous `0/O/1/I/L`), 8 characters → ~40 bits of entropy (32^8 ≈ 1.1×10¹²).
- **Expiration**: fixed server-side at **3 minutes** (`PAIRING_TTL_MS`), not configurable from the frontend/request body, matching mission §7's "quelques minutes maximum" and "ne pas rendre la durée configurable" requirements.
- **Single-use**: a pairing's code can only be successfully verified once; the row moves to `AWAITING_APPROVAL` on success and can never be re-verified. `APPROVED`/`DENIED` are terminal.
- **Attempt-bound**: max 5 verify attempts per pairing; the 6th (even with the correct code) fails, and the pairing is marked `DENIED`.
- **Rate limiting**: pairing *creation* is capped at 10/minute process-wide (sliding window, in-process) — mission §9's brute-force protection at the creation layer, distinct from the per-pairing attempt cap.
- **Code never persisted in plaintext** — only its SHA-256 hash. Verified by a dedicated test asserting the plaintext code string never appears anywhere in the stored pairing row or the audit log.
- **Human confirmation (mission §10/§11)**: even a correctly-verified code does **not** grant trust. `approvePairing()` is a distinct, explicit step; without it, no `omega_devices` row is ever created. The API surface itself (`POST /api/omega/pairing/approve` / `/deny`) is this phase's human-decision contract — a Phase 3+ concern is building the actual on-screen confirmation UI on the controlled device; this phase proves the backend gate is correctly enforced and independently callable/testable. No minimal frontend confirmation UI was built this phase (judgment call, documented in §9 below) since no live second-device flow exists yet to confirm against — building UI for an API that nothing can reach yet was judged premature; the backend gate is what actually enforces zero-trust-without-ALLOW, and it is fully tested via the route layer.
- **Permission recorded, not granted (mission §11)**: `requestedPermission` (`OMEGA_VIEW`/`OMEGA_INTERACTIVE`/`OMEGA_ADMIN`) is stored on the device record as a ceiling only. Phase 2 has no functional ADMIN action anywhere in the codebase — recording `OMEGA_ADMIN` as a device's permission level does not unlock any capability.

---

## 5. Mutual authentication (mission §12)

Phase 2 has no live two-device network session (that's Phase 3+'s screen/input data path). Mutual authentication is proven via **challenge-response signatures**:

1. Verifier (`POST /api/omega/challenge`) issues a fresh random 32-byte challenge (`crypto.randomBytes`), tracked server-side as issued-but-unconsumed with a 2-minute TTL.
2. The device signs the challenge with its private key (`crypto.sign`, Ed25519) — the private key itself is never transmitted.
3. The verifier checks the signature against the device's **registered** public key (`crypto.verify`) — never a key supplied fresh by the caller in that same call, always looked up server-side from `omega_devices`.
4. The challenge is **consumed on first use, regardless of outcome** — a captured challenge+signature pair cannot be replayed to mint a second session (added during this phase after the initial implementation surfaced this exact gap via a self-review; see `omega-pairing.js::issuedChallenges`).

This is real, standard, provable mutual auth without a live mTLS socket. **No TLS/mTLS listener was stood up in this phase** — the entire pairing/session API runs through Cortex's existing HTTP server on its existing loopback-guarded control-plane routes (see §8). A LAN-reachable listener for an actual second physical device, and the screen/input data path's own transport design, are explicitly deferred to Phase 3 per the Phase 1 architecture document.

---

## 6. Certificate / public-key pinning + identity-change detection (mission §13/§18)

After pairing, trust is bound to the device's exact public key/fingerprint, not merely its `deviceId`. Re-pairing with the **same** key reuses the same trusted device row (idempotent trust, tested). A **revoked** device that re-pairs — even with the identical key — is structurally prevented from resurrecting its old trust: `approvePairing()`'s fingerprint lookup only reuses an existing device row when `revoked_at IS NULL`; otherwise a brand-new `deviceId` is issued. This was caught and fixed during implementation: the original schema had a `UNIQUE` constraint on `fingerprint`, which broke this exact scenario (a revoked+re-paired device with the same key collided against its own old row). Fixed by dropping the column-level uniqueness (enforced instead in application logic, preferring the live/non-revoked row) — confirmed via a dedicated regression test (`test-omega-pairing.mjs`).

`DEVICE_IDENTITY_CHANGED`-equivalent behavior: a `deviceId` is never reused across a different key; a genuinely new key always yields a new device row, never silently re-trusting a previously-known `deviceId` under a new key.

---

## 7. Session model (mission §14/§15/§16)

`omega_sessions`: `id`, `device_id`, `permission_level`, `nonce`, `created_at`, `expires_at`, `ended_at`, `revoked_at`, `last_used_nonce`.

- **Not the pairing code reused**: sessions are minted only after a successful challenge-response proof, via a fresh `crypto.randomUUID()` id and a fresh `crypto.randomBytes(24)` nonce.
- **Short-lived**: fixed 15-minute TTL (`SESSION_TTL_MS`), not client-configurable.
- **Binding (mission §15)**: permission level is read from the device's server-recorded ceiling at session-creation time and **never** accepted from the client; `createSession({deviceId, permissionLevel: 3})` (an attempted smuggle) is simply ignored since the function has no such parameter — the whole call is destructured to `{deviceId}` only. A session minted for Device A is rejected outright if presented alongside Device B's id (`wrong_device`).
- **Anti-replay (mission §16)**: a nonce-chaining scheme — every validation call must present the server's last-issued nonce and receives a freshly rotated one in return. Presenting the same nonce twice (replay), a stale/old nonce, or a nonce for the wrong session all fail closed and log `REPLAY_REJECTED`.
- **Expiration**: an expired session fails validation and logs `SESSION_EXPIRED`.

---

## 8. Revocation + active-session invalidation (mission §17/§18)

`revokeDevice(deviceId)` (`omega-devices.js`):
1. Sets `omega_devices.revoked_at` (permanent, irreversible for that identity).
2. Immediately revokes **all** active sessions for that device (`omega_sessions.revoked_at`), checked live on every subsequent `validateAndAdvanceSession()` call rather than only at natural TTL expiry.
3. Also live-checks the device's `revoked_at` on every session validation independent of the session row's own `revoked_at`, so revocation is enforced even against a session the revocation call somehow missed.
4. Deletes any Docteur-side private key material under that device's namespace (a no-op for a remote device that never had one, since the remote device's own private key never left its own machine by construction).

A revoked device attempting to create a **new** session fails at `createSession()` (`device_revoked`). Re-trust requires a **full new pairing flow** — `approvePairing()`'s fingerprint-reuse logic structurally refuses to resurrect a revoked device row (§6 above), so there is no "re-authorize" shortcut.

---

## 9. Loopback / control-plane guard (mission §25)

`createOmegaRoute()` reuses `monitor.js`'s exact established guard template: `isLocal(c)` (via `getConnInfo(c).remote.address` against `127.0.0.1`/`::1`/`::ffff:127.0.0.1`) + hostname check + `Origin` header validated against `localhost`/`127.0.0.1`/`[::1]` only. No new network listener was created — this phase's confirmed guess (per the mission's own framing) held: zero new listener needed, since mutual auth is proven via signatures rather than a live socket, and every route runs on Cortex's existing HTTP server.

**Strict Local (mission §24)**: confirmed by inspection — no `omega-*.js` file or `omega.js` route imports `fetch`, `http`/`https` clients, or calls `assertCloudAllowed()`. There is no cloud/Internet code path in this phase's surface at all, so the guard was correctly never needed rather than merely unused.

---

## 10. Audit logging (mission §20)

`omega-audit.js` is the single choke point every OMEGA module writes through. Closed event-type enum (throws on an unlisted type, by design): `PAIRING_STARTED`, `PAIRING_CODE_FAILED`, `PAIRING_APPROVED`, `PAIRING_DENIED`, `PAIRING_EXPIRED`, `PAIRING_CONSUMED`, `SESSION_CREATED`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `DEVICE_REVOKED`, `IDENTITY_MISMATCH`, `REPLAY_REJECTED`. Each entry: `timestamp`, `event_type`, `device_id`, `session_id`, `pairing_id`, `result`, bounded `detail` JSON (4000-char cap, defends against unbounded audit-row growth). Never stores: pairing codes, session tokens, private key material. Verified by dedicated tests asserting the plaintext pairing code never appears in the audit log across a full lifecycle.

Pino redaction (`logger.js`'s shared `REDACT_PATHS`) extended with OMEGA field names: `pairingCode`, `code`, `sessionToken`, `privateKey`, `privateKeyPem`, `deviceKeyPem`, `nonce` — the same single choke point every other module's secrets already go through, not a separate mechanism.

---

## 11. API surface (mission §21)

Implemented on `createOmegaRoute()`, registered in `server.js` via `app.route('/api', createOmegaRoute({ logger }))` (after the existing route block, alongside `createStyleExamplesRoute`):

```
GET    /api/omega/status
GET    /api/omega/devices
GET    /api/omega/devices/:id            (extra — device detail read)
POST   /api/omega/pairing/start
POST   /api/omega/pairing/verify
POST   /api/omega/pairing/approve
POST   /api/omega/pairing/deny
GET    /api/omega/pairing/:id            (extra — pairing status read)
POST   /api/omega/challenge              (extra — mutual-auth challenge issuance)
POST   /api/omega/sessions
GET    /api/omega/sessions/:id           (extra — session status read)
POST   /api/omega/sessions/:id/validate  (extra — anti-replay proof point)
DELETE /api/omega/sessions/:id
POST   /api/omega/devices/:id/revoke
```

The mission's literal minimal list is fully present; the marked "extra" routes are specific, narrowly-scoped sub-resource reads/proofs (never a generic action endpoint — verified with a dedicated test that `POST /api/omega/action` 404s) needed to make the pairing/session/replay flow actually exercisable end-to-end through HTTP rather than only at the library layer. No `{command: "..."}` shape exists anywhere in this API.

Input validation (mission §23): `deviceId`/`pairingId`/`sessionId` are regex-bound (`^[a-zA-Z0-9-]{1,64}$`), rejecting path-traversal and shell-shaped values; request bodies are size-capped at 16KB; `requestedPermission` must be one of the closed enum values, never an arbitrary string.

---

## 12. Tests

| File | Tests | Result |
|---|---|---|
| `test-omega-identity.mjs` | 11 | 11/11 pass |
| `test-omega-pairing.mjs` | 28 | 28/28 pass |
| `test-omega-session.mjs` | 17 | 17/17 pass |
| `test-omega-route.mjs` | 19 | 19/19 pass |
| `test-omega-security.mjs` | 6 | 6/6 pass |
| **Total** | **81** | **81/81 pass** |

Coverage against mission §27/§28/§29/§30's explicit list: valid pairing, wrong code, expired code, reused code, too-many-attempts, approve, deny, revoked device, identity mismatch (wrong key / wrong deviceId), expired session, wrong session (device binding), permission tampering, token replay, nonce replay, session-after-revoke, cloned-DB-without-private-key, corrupted private-key blob, XSS-shaped display names (`<script>`, `<img onerror>`, `javascript:`), private-key/pairing-code/session-token absence from responses and logs, 100 device records (bounded query performance), many expired pairings (bounded cleanup), concurrent pairing verify attempts (exactly one succeeds).

Two real bugs were found and fixed via this test suite before it was considered complete:
1. `omega_devices.fingerprint UNIQUE` constraint broke the "revoked device re-pairs with same key → new device row" design — fixed by dropping the column constraint and enforcing live/non-revoked preference in the lookup query instead.
2. The mutual-auth challenge had no server-side consumption tracking, meaning a captured challenge+signature pair could be replayed to mint unlimited sessions — fixed by adding a single-use, TTL-bound issued-challenge set.

---

## 13. Regressions

Full `cortex-server` suite (124 `test-*.mjs` files) run via `node --test --test-timeout=20000 <file>` per file, matching prior phases' methodology.

**Aggregate (assertion-level, summed across all 124 files' own `node --test` summaries): 2027 total, 2021 pass, 3 fail, 3 cancelled.**

File-level breakdown of the non-passing 6:
- **fail (3 files, 1 assertion each)**: `test-find-eval.mjs`, `test-video-manual.mjs` — both match the mission's documented pre-existing baseline exactly. `test-video-pipeline.mjs` — NOT explicitly named in the mission's pre-briefed baseline list, but confirmed pre-existing and unrelated: `git status`/`git diff --stat` show this file was never touched this session, and the failure is `TypeError: mock.module is not a function` (this Node v22.22.3 invocation doesn't have `--experimental-test-module-mocks` enabled) — a Node-flag/invocation issue with zero connection to OMEGA, video/whisper code, or anything this phase changed.
- **cancelled (3 files, 20s harness-timeout each, per Node's own test-runner semantics — a timed-out assertion reports as `cancelled`, not `fail`)**: `test-cyber-audit-crawler.mjs`, `test-maitre-executor-level2.mjs`, `test-regression-api.mjs` — all three match the mission's documented pre-existing baseline exactly.

All 6 non-passing files were confirmed via `git status --short -- <file>` to have zero diff/status entry — none were touched by this session. No regression attributable to OMEGA's actual changes (`sqlite.js` schema/accessor additions are purely additive; `logger.js`'s `REDACT_PATHS` additions are purely additive field-name entries; `server.js`'s new route registration is a single new line) was found anywhere in the 124-file run. Strict Local's own dedicated suite (`test-strict-local-centralized.mjs`) ran clean (6/6) — expected, since OMEGA never touches or calls `strict-local.js`.

**Typecheck**: `npx tsc --noEmit` — exit 0, no errors.
**Build**: `npm run build` — exit 0, same pre-existing large-chunk warning as before (frontend untouched this phase).

---

## 14. Limitations (honest, not exhaustive elsewhere in this report)

- **No live two-device network session**: everything in this phase is provable via the API/library layer on one machine; Phase 3+ must design and implement the actual LAN transport for a second physical device to connect over.
- **No real mTLS/TLS listener**: mutual auth is signature-based challenge-response, not a live TLS socket. This was a deliberate, documented scope decision for Phase 2, not an oversight — but it means Phase 3's transport-level design is still fully open work.
- **No frontend pairing/confirmation UI was built this phase.** The human-confirmation gate is enforced and tested at the API layer (`approve`/`deny` are real, separate, required steps — no auto-accept path exists anywhere in the code), but there is no visible on-screen "Device X wants to pair, ALLOW/DENY" screen yet. This is a judgment call: building UI for a pairing flow that nothing can currently reach from a second physical device was judged premature relative to hardening the backend gate itself, which is where the actual security property lives.
- **Rate limiting is in-process, not persistent.** A Cortex restart resets the pairing-creation rate-limit window and the issued-challenge set. Given the mission's own framing (single-user local control plane, not an Internet-facing service), this was judged acceptable for V1 but is a real limitation if Cortex restarts are frequent during an active attack window.
- **No automated background cleanup job for expired pairings/sessions** beyond the opportunistic cleanup performed inside `startPairing()` (mission §31's "cleanup déterministe ou expiration logique fiable" is satisfied by the logical-expiration path — every read path re-checks `expires_at` live — rather than a separate scheduled sweep job). This is sufficient for correctness (nothing expired is ever usable) but means genuinely stale rows can accumulate in SQLite until the next `startPairing()` call happens to sweep them.
- **`capabilities.ts` was deliberately not touched this phase** (see checkpoint below) — no working end-to-end pairing between two real physical devices exists yet, only a fully-tested single-process simulation of both sides.

---

## DOCTEUR OMEGA PAIRING CHECKPOINT

Crypto implementation : Node built-in `crypto` only (Ed25519 keypairs via `generateKeyPairSync`, `crypto.sign`/`crypto.verify` for signing/mutual-auth, SHA-256 for fingerprints and pairing-code hashing, `crypto.randomBytes`/`crypto.randomInt` for all random generation, `crypto.timingSafeEqual` for code comparison). No third-party crypto/TLS dependency added.
Custom cryptography : 0 attendu — **0 confirmed**
Device identity : PASS
Private key storage : PASS (DPAPI via `secret-store.js`, namespace `omega-device-key:<deviceId>`, zero changes to `secret-store.js` itself)
Private key exposed : 0 attendu — **0 confirmed** (never in frontend, never in API responses, never in logs, never plaintext in SQLite — tested)
Pairing one-time : PASS
Pairing expiration : PASS (fixed 3-minute TTL, server-side only)
Pairing brute-force protection : PASS (5 attempts/pairing cap, 10 creations/minute process-wide rate limit, both tested)
Human confirmation : PASS (approve/deny are separate required steps; no auto-accept path exists)
Mutual authentication : PASS (challenge-response signatures over Ed25519, single-use/TTL-bound challenges; no live TLS/mTLS socket this phase — documented as deferred to Phase 3)
Public key / certificate pinning : PASS
Identity-change detection : PASS (revoked device cannot resurrect trust via re-pairing with the same key — bug found and fixed during this phase)
Session binding : PASS (device-bound, permission read server-side only, tested against tampering attempts)
Replay protection : PASS (nonce-chaining for sessions; single-use challenge consumption for mutual auth — the latter was a gap found and fixed during this phase)
Revocation : PASS
Active-session invalidation : PASS (live-checked on every validation call, not just at TTL expiry)
Strict Local : PASS (no cloud/Internet code path exists in this phase's surface at all; confirmed by inspection, `assertCloudAllowed` correctly never called since never needed)
Cloud calls : 0 attendu — **0 confirmed**
Internet relay : 0 attendu — **0 confirmed**
Screen capture : 0 attendu — **0 confirmed**
Mouse injection : 0 attendu — **0 confirmed**
Keyboard injection : 0 attendu — **0 confirmed**
Admin execution : 0 attendu — **0 confirmed**
Arbitrary shell : 0 attendu — **0 confirmed**
Secrets exposed : 0 attendu — **0 confirmed**
OMEGA tests : 81/81
Relevant regressions : PASS (full 124-file suite: 2027 assertions total, 2021 pass, 3 fail, 3 cancelled — all 6 non-passing files confirmed pre-existing and untouched by this session via `git status`; 5 of 6 match the mission's documented baseline exactly, the 6th — `test-video-pipeline.mjs` — is a pre-existing `mock.module` Node-flag incompatibility unrelated to OMEGA; Strict Local suite 6/6 clean)
Typecheck : PASS
Build : PASS
Files changed : `cortex-server/src/lib/omega-identity.js` (new), `cortex-server/src/lib/omega-pairing.js` (new), `cortex-server/src/lib/omega-session.js` (new), `cortex-server/src/lib/omega-devices.js` (new), `cortex-server/src/lib/omega-audit.js` (new), `cortex-server/src/routes/omega.js` (new), `cortex-server/test-omega-identity.mjs` (new), `cortex-server/test-omega-pairing.mjs` (new), `cortex-server/test-omega-session.mjs` (new), `cortex-server/test-omega-route.mjs` (new), `cortex-server/test-omega-security.mjs` (new), `cortex-server/src/lib/sqlite.js` (modified — new `omega_*` schema block + accessor functions, purely additive), `cortex-server/src/lib/logger.js` (modified — new OMEGA field names added to shared `REDACT_PATHS`, purely additive), `cortex-server/src/server.js` (modified — one new route-registration line + one new import line). `capabilities.ts` NOT touched.
Known limitations : No live two-device network session yet (Phase 3+ work); no real TLS/mTLS listener (challenge-response signatures used instead, documented decision); no frontend pairing-confirmation UI built this phase (backend gate fully enforced and tested instead); rate limiting and issued-challenge tracking are in-process only, reset on Cortex restart; no separate scheduled cleanup job for expired rows (logical-expiration-on-read is relied upon instead).
Verdict : PASS

Then STOP. NE PAS COMMENCER PHASE 3 — VIEW ONLY.
