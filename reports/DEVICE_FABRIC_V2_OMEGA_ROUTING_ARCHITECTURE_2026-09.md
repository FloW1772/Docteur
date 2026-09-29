# DOCTEUR DEVICE FABRIC V2 — PHASE 1: OMEGA V2 ROUTING ARCHITECTURE + SECURITY AUDIT

Date: 2026-09-28 · Mode: audit and architecture only · Baseline: `035684a` (clean tree at start; `.gitignore` diff made in the prior mission was already committed)

**Scope**: design only. **No file was created except this report.** OMEGA V2, RASSILON V1, Device Fabric V1, SQLite, routes, UI and dependencies are all untouched.

**Git safety precondition**: the last `DOCTEUR OMEGA V2 FINAL GIT/GITHUB CHECKPOINT` reported `GitHub push readiness: PASS`. Re-verified live at the start of this mission: `git status --short` is empty (clean tree), and the entire OMEGA V2 change set that checkpoint staged is now committed at `035684a`. **Precondition: PASS.** Proceeding.

**Sources read in full**: `DEVICE_FABRIC_ARCHITECTURE_2026-09.md`, `DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md`, `DEVICE_FABRIC_RASSILON_ROUTING_V1_2026-09.md`, `DEVICE_FABRIC_V1_FINAL_CERTIFICATION_2026-09.md`, `OMEGA_V2_OUTBOUND_ARCHITECTURE_2026-09.md`, `OMEGA_V2_OUTBOUND_TRANSPORT_V1_2026-09.md`, `OMEGA_V2_OUTBOUND_VIEW_V1_2026-09.md`, `OMEGA_V2_OUTBOUND_INTERACTIVE_V1_2026-09.md`, `OMEGA_V2_OUTBOUND_ADMIN_V1_2026-09.md`, `OMEGA_V2_FINAL_CERTIFICATION_2026-09.md`, plus a direct code audit of `device-fabric.js`, `device-fabric-agents.js`, `device-fabric-routing.js`, `routes/device-fabric.js`, `omega-outbound-client.js`, `routes/omega-outbound.js`, `omega-identity.js`, `omega-outbound-identity.js`.

---

## 1. Key audit finding that shapes everything below

**Device Fabric V1's existing `agentType: 'OMEGA'` link is the wrong link for this mission, and must not be reused or extended.**

| | Fabric V1's existing `OMEGA` link | What this mission needs |
|---|---|---|
| Direction | `REMOTE_ACTS_ON_THIS_PC` — a remote OMEGA V1 client paired *to* this PC | `THIS_PC_ACTS_ON_REMOTE` — this PC as an OMEGA V2 outbound controller acting *on* a remote host |
| Source table | `omega_devices` (V1 inbound) | `omega_v2_outbound_trust` (V2 outbound, a different table, different schema) |
| Device-id format | plain UUID (`crypto.randomUUID()`) | `ov2h-<uuid>` (OMEGA V2 host role prefix) |
| Identity domain | OMEGA V1's `omega-device-key:` DPAPI namespace | OMEGA V2's `omega-v2-role-key:controller:*` DPAPI namespace (this PC's own controller identity) — the remote host's key is never held by this PC at all |
| Fabric code that reads it | `device-fabric-agents.js` `projectOmegaRow()` ← `getAllOmegaDevices()` | none exists yet |

Reusing the existing `OMEGA` link for V2 would silently conflate two unrelated identity spaces and two opposite directions under one label. **Architecture decision: a new, separate link kind is required.** §7 below names it `agentType: 'OMEGA_V2_OUTBOUND'`, kept fully distinct from the existing `OMEGA` (V1 inbound) link. A `fabricDeviceId` may in principle carry both — e.g. a laptop that is simultaneously an OMEGA V1 client of this PC *and* an OMEGA V2 outbound target this PC controls — without either link affecting the other, exactly as OMEGA and RASSILON links already coexist independently today (Device Fabric V1 §28 of the mission, already satisfied by the existing per-agent-type unique-index design).

This finding also resolves the Device Fabric V1 architecture report's own F1 limitation ("OMEGA V1 is host-only, so `OMEGA_*` routing is `NOT_ROUTABLE`" — `OMEGA_ROUTING_REASON = 'omega_outbound_client_not_implemented'`, still present unchanged in `device-fabric.js:86`). **That limitation is now specifically about V1.** OMEGA V2 supplies exactly the missing outbound client Device Fabric V1 was waiting for. Nothing about Device Fabric V1's `OMEGA_*` routing (still `NOT_ROUTABLE`) needs to change for this: a new, additive action family is proposed instead of repurposing the frozen one (§14).

## 2. Current Device Fabric V1 architecture (audited)

- **Purpose**: `fabricDeviceId` (`fdev-<uuid>`) is an opaque local inventory label. It carries no credential and no permission. `fabric_devices`, `fabric_agent_links`, `fabric_audit`, `fabric_operations` are additive tables with no FK into `omega_*` or `rassilon_*`.
- **Link model**: at most one active link per `(fabricDeviceId, agentType)` and at most one active link per `(agentType, agentDeviceId)` — both partial unique SQLite indexes. Linking is explicit, requires `confirmFingerprint` to match the agent's current fingerprint exactly, and is refused on: missing identity, revoked identity, fingerprint mismatch, cross-agent key reuse (same fingerprint held by the other domain), or an identity already linked elsewhere.
- **Staleness**: computed at read time from the live agent projection, never persisted. `linkState` ∈ `OK | MISSING | FINGERPRINT_MISMATCH | AGENT_ERROR`. A non-`OK` link is never routable.
- **Capability model**: SUPPORTED / AUTHORIZED / AVAILABLE, each ∈ `YES | NO | UNKNOWN`, never merged into one boolean. `routable` is a separate derived flag (`isRoutableCapability`), true today only for RASSILON in the `THIS_PC_SENDS_COMPUTE` direction.
- **Routing (RASSILON only, Phase 3/4)**: `resolveExactRassilonTarget()` walks link → linkState → trust → direction → capability gates → **re-reads the worker record fresh from RASSILON's own store** → re-checks fingerprint and role → checks outbound session state → calls `dispatchRassilonRemoteJob({ devices: [worker], preferredDeviceId: worker.deviceId })`, i.e. the RASSILON scheduler is handed a **single-element device list**, which is what makes fallback structurally impossible (RASSILON's own `preferredDeviceId`-not-found fallback, F7, only ever sees the one device Fabric handed it).
- **Result binding**: `summarizeVerifiedOutput()` accepts a result only if its shape and content match the exact job's declared kind/parameters, then discards raw vectors and keeps only a bounded summary.
- **State machine**: `fabric_operations` transitions are enforced by `UPDATE … WHERE status IN (<allowed sources>)`; a terminal state is unreachable a second time (`transitionFabricOperation`, added in Phase 4 to close a double-completion bug).
- **STOP**: no STOP exists yet in Fabric for either agent as a Fabric-initiated primitive beyond an operation naturally failing when the agent's own STOP already ran. `OMEGA_*` is `NOT_ROUTABLE` (V1 has no outbound path), so OMEGA STOP was never reachable from Fabric.
- **Audit**: `fabric_audit` and `fabric_operations` hold only ids, enum event types, and bounded safe summaries — no key, session, token, text or vector, verified by both static and dynamic tests.
- **API**: `/api/device-fabric/*`, loopback + Host + Origin localhost guarded, JSON-only, body-limited, no `/execute`/`/shell`/`/command`/`/run`/`/rpc` route exists (tested against 404 on the real server).
- **Certified state**: PASS, FROZEN (2026-09-24). 84/84 backend, 79/79 browser, 13/13 real-process RASSILON harness.

## 3. Current OMEGA V2 outbound interface (audited)

OMEGA V2 outbound is the certified, frozen (2026-09-28) controller-side API this PC already has for acting on a remote OMEGA V2 host. It is a **complete, closed, loopback-only local API** — everything Device Fabric V2 would eventually need already exists as a typed function and a typed local route; no new OMEGA capability is implied by this mission.

### 3.1 Identity and trust (`omega-outbound-identity.js`, `omega-outbound-store.js`)

- Two Ed25519 identities per install, role-separated: `CONTROLLER` (`ov2c-*`) and `HOST` (`ov2h-*`), private keys in DPAPI under `omega-v2-role-key:<role>:<id>`, never in SQLite, never returned by any API.
- `omega_v2_outbound_trust`: hosts *this PC* is allowed to control — `remoteDeviceId` (`ov2h-*`), host/port, certificate PEM + fingerprint (pinned), public key + fingerprint, `maxPermission`.
- Registering a trust (`registerOmegaOutboundHost`) requires the caller to already possess the target's certificate PEM, fingerprint and public key — i.e. an out-of-band pairing bundle. **Fabric cannot create this trust and must not attempt to.**
- `connectOmegaDevice(remoteDeviceId, permission)` performs the full TLS+SAN+pin+mutual-Ed25519-challenge handshake and returns a session bound to the exact `remoteDeviceId`, capped at the trust's `maxPermission`.

### 3.2 Sessions (`omega_v2_sessions`, 15-minute TTL)

- `permission` ∈ `VIEW | INTERACTIVE | ADMIN`, fixed at connect time by the host, never elevated afterward.
- `listOmegaOutboundSessions()` / `getOmegaOutboundSession(id)` / `refreshOmegaOutboundSession(id)` (signed status poll) / `stopOmegaOutboundSession(id)` / `stopAllOmegaOutboundSessions()`.
- A signed status monitor polls every 5s and fail-closes on STOP/revocation/expiry; it never reconnects.

### 3.3 VIEW, INTERACTIVE, ADMIN — typed functions

| Capability | Typed controller functions |
|---|---|
| VIEW | `startOmegaOutboundView(sessionId, screenIndex)`, `getOmegaOutboundViewStatus`, `fetchOmegaOutboundViewFrame`, `stopOmegaOutboundView` |
| INTERACTIVE | `startOmegaOutboundInteractive(sessionId)`, `getOmegaOutboundInteractiveStatus`, `sendOmegaOutboundInput(sessionId, category, input)`, `stopOmegaOutboundInteractive` |
| ADMIN (read) | `getOmegaOutboundAdminSystemInfo`, `listOmegaOutboundAdminProcesses`, `getOmegaOutboundAdminServiceStatus`, `getOmegaOutboundAdminNetworkStatus`, `getOmegaOutboundAdminDiskStatus` |
| ADMIN (high impact) | `requestOmegaOutboundAdminLock/Logoff/Restart/Shutdown` — return `PENDING_APPROVAL`; a poller (`getOmegaOutboundAdminOperation`) or `cancelOmegaOutboundAdminOperation` tracks/cancels the operation. **The controller has no approval function; approval exists only on the host's local UI.** |

Every one of these already: re-validates the session, re-validates the exact target device, re-checks TLS pin/SAN, re-checks permission, and is rate-limited server-side. None accepts a raw command, script, path or credential — this was independently confirmed in the OMEGA V2 Final Certification static scan (0 hits across `shell:true`/`eval(`/`exec(`/generic-RPC patterns).

### 3.4 Local API surface (`/api/omega/outbound/*`, loopback-guarded)

`GET /identity`, `GET|POST /trust/hosts[/:id/revoke]`, `POST /trust/controllers[/:id/revoke]`, `POST /connect`, `GET /sessions[/:id]`, `POST|GET /sessions/:id/view/{start,status,frame,stop}`, `POST|GET /sessions/:id/interactive/{start,status,stop}`, `POST /sessions/:id/input/{pointer,button,wheel,key}`, `POST|GET /sessions/:id/admin/{system-info,processes,services,network,disks}`, `POST /sessions/:id/admin/{lock,logoff,restart,shutdown}/request`, `GET|POST /sessions/:id/admin/operations/:operationId[/cancel]`, `POST /sessions/:id/stop`, `POST /stop-all`, `GET /audit`.

This is the exact set a Fabric router would call **as a client**, from the same loopback origin, the same way `OmegaOutboundViewTab.tsx` and `OmegaOutboundAdminPanel.tsx` already do. **No new OMEGA route is implied.**

### 3.5 STOP model (audited)

`STOP VIEW`/`STOP INTERACTIVE` (scoped), `STOP SESSION` (`POST /sessions/:id/stop`, cascades to VIEW+INTERACTIVE+ADMIN, always attempted even if the network call fails — "local STOP remains authoritative", verified in `stopOmegaOutboundSession`'s own comment), `STOP ALL` (`POST /stop-all`, local-only, not a broadcast — iterates this controller's own active sessions). Remote STOP (host-initiated) is observed by the controller within one status-poll cycle (≤5s) and fails the session closed. None of these primitives needs to change for Fabric to call them.

### 3.6 ADMIN approval model (audited, unchanged from Phase 5 certification)

High-impact ADMIN is `PENDING_APPROVAL → EXECUTED|DENIED|CANCELLED|EXPIRED|FAILED`. The approval decision is made **exclusively** by the host's own local WinForms prompt (`omega-admin-prompt.ps1`), reachable only from that host's own process, never over the network, never by the controller. There is no `approve` route anywhere in `/api/omega/outbound/*` or `/api/omega-v2/*` (confirmed: only `request | status | cancel` exist for ADMIN). **This means Fabric, like the existing UI, can only ever request and observe — never approve.**

## 4. Invariant restated for V2: Device Fabric is inventory + orchestration, not authority

Carried forward unchanged from Device Fabric V1 (§6 of the mission, §19 "confused deputy" analysis of the Phase 1 V1 report), and now additionally checked against the OMEGA V2 surface specifically:

- Fabric holds **0** OMEGA V2 private keys (both `ov2c-*` controller and any `ov2h-*` host key stay exclusively in OMEGA V2's own DPAPI namespace; Fabric would only ever store the **public** `remoteDeviceId`/fingerprint pair needed to name the link, exactly as it already does for the RASSILON worker link).
- Fabric holds **0** OMEGA V2 session secrets: sessions are OMEGA V2's own, created/read/stopped through the typed functions in §3.2, never persisted by Fabric.
- Fabric holds **0** ADMIN approvals: it cannot approve, and would not gain an approval function even conceptually (§3.6).
- Fabric decides only "this `fabricDeviceId` names `omegaDeviceId` X" — never "X has ADMIN". OMEGA decides that, every single request, from its own `omega_v2_sessions.permission`.

## 5. Identity/link model (design)

### 5.1 `fabricDeviceId` stays a pure label

Unchanged from V1: `fdev-<uuid>`, never a credential, never a routing target by itself.

### 5.2 New link kind: `OMEGA_V2_OUTBOUND`

Extends the closed `FABRIC_AGENT_TYPES` enum (currently `['OMEGA', 'RASSILON']`) conceptually with a **third, additive** value, kept structurally separate from the existing `'OMEGA'` (V1 inbound) value at every layer — enum, table row, UI section, capability block:

```
FABRIC_AGENT_TYPES (future): ['OMEGA', 'RASSILON', 'OMEGA_V2_OUTBOUND']
```

A link row of this kind stores, at minimum (mirroring the existing `fabric_agent_links` shape exactly, §15):

- `agent_type = 'OMEGA_V2_OUTBOUND'`
- `agent_device_id` = the exact `remoteDeviceId` (`ov2h-<uuid>`) from `omega_v2_outbound_trust`
- `agent_fingerprint` = the trust's **identity fingerprint** (the OMEGA V2 host's Ed25519 public-key fingerprint — not the TLS certificate fingerprint, which is a separate pinned value already owned and re-verified by OMEGA V2 itself on every connect)
- `linked_at`, `link_status` — unchanged mechanics

**No new column type, no secret, no session, no certificate material** — same shape as the existing RASSILON/OMEGA link rows.

### 5.3 Resolution: `fabricDeviceId → omegaDeviceId`, no proxy identifiers

Exactly the RASSILON precedent (§2, `resolveExactRassilonTarget`): Fabric never invents its own device identifier for OMEGA V2. The link row's `agent_device_id` **is** the `remoteDeviceId` OMEGA V2's own `connectOmegaDevice(remoteDeviceId, permission)` expects. No translation layer, no alias table, no second source of truth for "which host is this."

### 5.4 No hostname/IP/MAC/displayName/fingerprint-equality matching — ever

Carried forward unchanged from V1 §6 ("Preuve de lien") and directly required by mission §8/§40: linking is **only** ever `confirmFingerprint` against the identity fingerprint the user is shown, read from `listOmegaOutboundHosts()` (already-registered outbound trusts only — Fabric lists what's already registered, never proposes a target from network discovery, because none exists). The user must have separately completed OMEGA V2's own out-of-band pairing-bundle exchange (§3.1) before a Fabric link is even offerable.

## 6. Exact routing, no fallback (design)

### 6.1 Why "no fallback" is easier to guarantee for OMEGA V2 than it was for RASSILON

RASSILON needed the `devices: [worker]` single-element-list trick specifically because `dispatchRassilonRemoteJob` has an internal scheduler that *can* pick among a device list (F7). **OMEGA V2 has no such scheduler at all.** Every OMEGA V2 typed function (§3.3) already takes an exact `sessionId`, and a `sessionId` is already bound, inside OMEGA V2 itself, to one exact `remoteDeviceId` at connect time (`omega_v2_sessions.remote_device_id`, re-verified server-side on every signed request per the Transport/View/Interactive/Admin reports). **There is structurally nowhere in the OMEGA V2 API for a second device to be substituted** — not by Fabric, not by a bug, because no OMEGA V2 function accepts a device list or a "preferred" hint that could be overridden. This is a stronger no-fallback guarantee than RASSILON's, inherited for free from OMEGA V2's own design, not something Fabric has to newly enforce.

### 6.2 Resolution flow (mirrors §19 of the mission and §2's RASSILON precedent exactly)

```
1. resolve fabricDeviceId → fabric_agent_links row where agent_type='OMEGA_V2_OUTBOUND', link_status='ACTIVE'
   └ none → OMEGA_NOT_LINKED

2. re-read the OMEGA V2 outbound trust fresh: getOutboundTrust(link.agent_device_id)
   (own OMEGA V2 store function, not cached, not the Fabric link row's copy)
   └ missing or revoked → OMEGA_UNTRUSTED / OMEGA_REVOKED

3. compare trust.identity_fingerprint to link.agent_fingerprint (case-normalized)
   └ mismatch → OMEGA_LINK_STALE

4. call connectOmegaDevice(trust.remoteDeviceId, requestedPermission)
   — OMEGA V2 itself now performs: RFC1918/Private-profile check, TLS handshake,
     SAN check, certificate-pin check, mutual Ed25519 challenge, permission
     ceiling clamp against trust.maxPermission
   └ any failure → OMEGA_TLS_FAILURE / OMEGA_UNAVAILABLE / OMEGA_PERMISSION_DENIED (§35 mapping)

5. call the requested typed function (startOmegaOutboundView / …/
   sendOmegaOutboundInput / requestOmegaOutboundAdminLock / …) with the
   sessionId connectOmegaDevice just returned
   — OMEGA V2 re-validates session liveness, exact device, exact permission,
     replay/nonce, rate limits — on every single call, independent of step 4

6. normalize the result to a safe projection (§8) and return it,
   tagged with {fabricDeviceId, agentType: 'OMEGA_V2_OUTBOUND', agentDeviceId, sessionId, correlationId}
```

No step in this flow can substitute a different device: step 1 names exactly one link, step 2 re-reads exactly that link's target, step 4's `remoteDeviceId` argument is a scalar (not a list), and step 5's `sessionId` is already bound server-side to that one device.

### 6.3 TOCTOU analysis (mission §46)

**Threat**: Fabric resolves the link to device A, the link changes to device B between resolution and the call, the operation proceeds against B while the user/audit believe it targeted A.

**Why this is structurally harder to exploit here than a generic TOCTOU**: step 4 above (`connectOmegaDevice`) is **itself** the revalidation — it doesn't trust step 1–3's resolution as a capability token, it re-derives `trust` from `omega_v2_outbound_trust` fresh and performs a real TLS handshake + Ed25519 challenge against whatever is *actually* listening at that trust's pinned host/port/certificate. If the Fabric link row were somehow stale by the time step 4 ran, `connectOmegaDevice` would either connect to the same still-correct target (because it re-reads the trust table itself, not Fabric's cached copy) or fail closed on a TLS/certificate mismatch — it cannot silently connect to "whatever B is" because B's identity was never passed to it; only the **link's recorded `remoteDeviceId` string** was, and that string is re-read from Fabric's own row at the moment of use (step 1), not cached across an `await`.

**Residual TOCTOU window, honestly documented**: between step 1 (read the link row) and step 4 (call `connectOmegaDevice`), the *link itself* could be deleted or repointed by a concurrent user action (unlink + relink to a different `omegaDeviceId`) in the same process. Mitigation for Phase 2+: re-read the link row a second time immediately before constructing the `connectOmegaDevice` call (not once at the top of the request handler), and compare `agent_device_id` byte-for-byte against the first read — if they differ, fail closed with `OMEGA_LINK_STALE` rather than proceeding with either value. This mirrors the mission's own suggested mitigation (§46: "link identity/version/fingerprint revalidation immediately before call") and is cheap (one extra SQLite read) because Fabric's own tables are local and synchronous.

**For an already-*established* session** (steps 5+, i.e. VIEW/INTERACTIVE/ADMIN calls made after `connectOmegaDevice` succeeded), TOCTOU on the link is moot: the `sessionId` already encodes the exact target inside OMEGA V2's own store, and a link change afterward cannot retroactively redirect an existing session — the next Fabric-initiated call still passes the *same* `sessionId`, which OMEGA V2 resolves independently of Fabric's link table.

## 7. Trust separation (design)

Unchanged principle from V1 §11/§27 of the mission, now stated for the three-agent-type case:

- OMEGA V2 trust (`omega_v2_outbound_trust`, `omega_v2_sessions.permission`) is authoritative and **never read into a decision by Fabric** — only ever displayed.
- RASSILON trust is untouched, unread by this feature, unaffected.
- A `fabricDeviceId` may carry an `OMEGA_V2_OUTBOUND` link, an `OMEGA` (V1 inbound) link, and a `RASSILON` link simultaneously, on the **same** physical machine, as three fully independent rows with three independent trust states, three independent revocations, and — critically — **three independent identities and key material**, per mission §28. No code path may read one to answer a question about another (this is the same "aucune lecture d'autorisation inter-domaine" invariant already tested for the OMEGA/RASSILON pair in `test-device-fabric-core.mjs`; a third pairwise test set — `OMEGA_V2_OUTBOUND` vs `OMEGA` and `OMEGA_V2_OUTBOUND` vs `RASSILON` — is added to the Phase 2+ test plan, §21).
- Cross-agent key reuse: the existing `cross_agent_key_reuse` rejection (device-fabric.js `linkAgent`, checking the fingerprint against the *other* domain's identity set) extends to a **three-way** check: linking `OMEGA_V2_OUTBOUND` must also reject if the fingerprint appears in `OMEGA` (V1) or `RASSILON` identities, and vice versa. Note the fingerprint spaces are already algorithmically compatible (OMEGA V1, OMEGA V2 and RASSILON all use SHA-256 of the SPKI-DER Ed25519/RSA public key — confirmed identical `identityFingerprint()`/`computeFingerprint()` shape across `omega-identity.js`, `omega-outbound-protocol.js`, `rassilon-identity.js`), so the comparison is a direct string equality, exactly like the existing two-way check.

## 8. Availability / status model (design)

### 8.1 What OMEGA V2 certified reports actually let us say honestly

Unlike OMEGA V1 (whose Device Fabric V1 architecture report found **no** availability signal exists at all — F4, "AVAILABLE always UNKNOWN"), OMEGA V2 outbound gives Fabric a real, bounded set of honest signals **once a session exists**:

| Signal | Source | What it proves |
|---|---|---|
| Trust exists, not revoked | `omega_v2_outbound_trust` row present, `revoked_at IS NULL` | the host was paired; says nothing about current reachability |
| `connectOmegaDevice` succeeds | live TLS+Ed25519 handshake | the host is reachable **right now**, at the moment of the call |
| `refreshOmegaOutboundSession` / status monitor | signed status poll on an existing session | the session is still `CONNECTED` **as of the last ≤5s poll** |
| Session absent/ended | `getOmegaOutboundSession(id)` returns `status ≠ CONNECTED'` or `null` | no current session; says nothing about whether the host is reachable *now* |

### 8.2 Applying the mission's SUPPORTED/AUTHORIZED/AVAILABLE separation (§14–§15)

| | Value | Basis |
|---|---|---|
| SUPPORTED | `VIEW`: YES if linked (OMEGA V2 always supports VIEW for any ADMIN-or-above trust); `INTERACTIVE`/`ADMIN`: YES if `trust.maxPermission` ≥ that level, else NO | static, read from the trust row, never a live probe |
| AUTHORIZED | mirrors SUPPORTED here — OMEGA V2's `maxPermission` **is** the authorization ceiling; there is no separate "announced capability" layer to distrust, unlike RASSILON's self-announced `capabilities.safeExecutorTypes` | `trust.max_permission`, re-read live, not cached |
| AVAILABLE | **UNKNOWN** if no active session exists for this link (no live signal without spending a connect attempt — see §8.3); **AVAILABLE** only while an active session's last status poll (≤5s old) reported `CONNECTED`; **UNAVAILABLE** if the last known session ended, expired, was revoked, or a connect attempt just failed | the *existing* OMEGA V2 session/status machinery, read, never re-implemented |

**Crucially: AVAILABLE must never read YES merely because a link row exists.** This directly satisfies mission §15's "ne jamais afficher ONLINE sur simple existence d'un lien Fabric" — the same rule Device Fabric V1 already enforces for the OMEGA-V1 case (always UNKNOWN there) and for RASSILON (requires a fresh signal within a 30s window).

### 8.3 The "probe cost" problem, honestly flagged

Unlike RASSILON's `refreshRassilonWorkerStatus` (a lightweight authenticated `/status` ping with no side effect beyond updating `last_seen`), the *only* way to prove an OMEGA V2 host is currently reachable is `connectOmegaDevice`, which is a **full TLS handshake + mutual authentication + a real session creation** — not a free probe. This is architecturally different from RASSILON and must be designed for explicitly in Phase 2+, not assumed away:

- A "check availability" button in Fabric's UI would, for OMEGA V2, necessarily mean "create a short-lived VIEW-or-lower session, observe CONNECTED, then immediately `stopOmegaOutboundSession`" — a real connect/disconnect cycle, rate-limited by OMEGA V2's own existing `MAX_CONNECTS_PER_MINUTE = 10` per remote device (already enforced in `omega-outbound-client.js`, unmodified).
- Alternative for Phase 2+ to evaluate (not decided here): show AVAILABLE=UNKNOWN with a "connect to check" action rather than a dedicated probe button, since a probe *is* a connect for this agent. This is a real design question for Phase 2, flagged rather than resolved.
- No heartbeat is proposed (mission §17): OMEGA V2 has no lightweight heartbeat primitive to reuse, and adding one would itself be new OMEGA V2 capability — explicitly out of scope for a Fabric mission.

### 8.4 Freshness

Same discipline as the RASSILON 30s window (Device Fabric V1 §12/§16): a session's `CONNECTED` status is trusted only as of its **last observed poll timestamp**, aged locally by the UI (client-side clock, no network call, exactly the Phase 4 hardening pattern already shipped for RASSILON's presence/session display — `H5` in the V1 Final Certification report). A poll older than the OMEGA V2 status-monitor's own 5s interval **plus a small grace window** (proposed: 10s total, doubling the monitor interval, mirroring the existing 6s INTERACTIVE lease pattern's own 2x-poll-interval margin) downgrades AVAILABLE to UNKNOWN, never leaves it stuck at YES.

## 9. Session ownership (design)

**OMEGA V2 remains the sole source of truth.** Per mission §33, Fabric's `fabric_operations`-equivalent row for an OMEGA V2 action should hold, at most, a **safe session reference** (`sessionId`, opaque, already non-secret per OMEGA V2's own design — "the `sessionId` alone authorizes nothing," Transport report §8) — never a token, never a nonce, never a private key. Preference confirmed: **no durable session state at all** is the simpler and safer option, since every OMEGA V2 typed function already takes a `sessionId` Fabric would just be relaying, and `listOmegaOutboundSessions()` already gives Fabric a live, authoritative list to join against by `remoteDeviceId` without storing anything itself. Recommendation for Phase 2+: Fabric's operation row stores `sessionId` only as a **display/correlation** convenience (like RASSILON's `jobId`), re-validated live against `getOmegaOutboundSession(sessionId)` on every read, never trusted as a capability.

## 10. Process restart (design)

Per mission §34, and confirmed by direct precedent: OMEGA V2's own store already marks any session found `CONNECTED`/`AUTHENTICATING`/`CONNECTING` at boot as `INTERRUPTED` (`initializeOmegaOutboundStore()` in `omega-outbound-store.js`, unmodified, already certified). **Fabric inherits this for free** by simply never assuming a stored `sessionId` is still live — every read goes through `getOmegaOutboundSession`/`listOmegaOutboundSessions`, which will correctly report `INTERRUPTED`/absent after a restart. No Fabric-side "was this session active before restart" logic should exist; querying OMEGA V2 fresh is suf2ficient and is the only correct approach (mirrors `recoverInterruptedFabricOperations()`, which Device Fabric already runs at boot for its *own* RASSILON-routed operations — the same pattern, applied to a query instead of a state mutation, since OMEGA V2 already did the state mutation itself).

## 11. VIEW routing design

- `fabricStartOmegaView(fabricDeviceId, screenIndex)` → resolve (§6.2) → `connectOmegaDevice(remoteDeviceId, 'VIEW')` if no live session, else reuse → `startOmegaOutboundView(sessionId, screenIndex)`.
- **Fabric does not touch frame bytes.** Per mission §21, the existing `OmegaOutboundViewTab.tsx` frame-pull/render loop (`/sessions/:id/view/frame`, PNG blob, `<img>` element, `pointer-events: none`) is the correct, already-certified UI path. A future Fabric-routed VIEW should **reuse that component**, parameterized by the resolved `sessionId`, rather than Fabric re-implementing frame transport. This satisfies "pas de stockage Fabric des captures" trivially: Fabric never sees a frame at all if it only orchestrates session lifecycle and hands the UI a `sessionId`.
- STOP: `fabricStopOmegaView(fabricDeviceId)` → `stopOmegaOutboundView(sessionId)`.

## 12. INTERACTIVE routing design

- `fabricStartOmegaInteractive(fabricDeviceId)` → requires an active VIEW session on the resolved target (OMEGA V2 itself enforces this: `startOmegaOutboundInteractive` fails `VIEW_NOT_ACTIVE` otherwise) → `startOmegaOutboundInteractive(sessionId)`.
- **Fabric never synthesizes input.** Per mission §22, mouse/keyboard events originate only from the existing `OmegaOutboundViewTab.tsx` viewport handlers (`onPointerMove`/`onPointerDown`/`onKeyDown`/…), which already call `sendOmegaOutboundInput` directly. A Fabric-routed session is still driven by that same component; Fabric's role stops at handing it a resolved `sessionId`. No `fabricSendOmegaInput(...)` function is proposed — it would be exactly the generic input-relay primitive the mission prohibits (§20/§22 combined: Fabric must not become an input path).
- STOP: `fabricStopOmegaInteractive(fabricDeviceId)` → `stopOmegaOutboundInteractive(sessionId)`.

## 13. ADMIN routing design

- `fabricRunOmegaAdminAction(fabricDeviceId, semanticAction)`, where `semanticAction` ∈ the closed 9-value OMEGA V2 ADMIN enum — **not** a free string, checked against `OMEGA_V2_ADMIN_ACTIONS` (already exported, frozen, from `omega-outbound-admin.js`) before any dispatch.
- **Read actions** (`GET_SYSTEM_INFO`, `PROCESS_LIST`, `SERVICE_STATUS`, `NETWORK_STATUS`, `DISK_STATUS`): map 1:1 to the five typed read functions (§3.3), each already returning a bounded, schema-validated, XSS-safe-by-construction projection.
- **High-impact actions** (`LOCK`, `LOGOFF`, `RESTART`, `SHUTDOWN`): map 1:1 to the four typed request functions. Fabric's role ends at calling `requestOmegaOutboundAdmin{Lock,Logoff,Restart,Shutdown}(sessionId)` and returning the resulting `PENDING_APPROVAL` operation for the UI to poll/display — exactly mirroring what `OmegaOutboundAdminPanel.tsx` already does locally. **Fabric contains no ADMIN execution engine** (mission §23): it transmits one semantic action and relays the typed result, nothing else.
- **No generic `fabricRunOmegaAdminAction(fabricDeviceId, actionName, rawArgs)`** — `rawArgs` does not exist in this design. The closed enum *is* the entire input surface, matching OMEGA V2's own "typed functions, zero-argument executors" design exactly (Phase 5 report §30: "Prefer typed functions... No user-controlled command string").

## 14. High-impact approval preserved (design)

Directly satisfies mission §24 and follows from §3.6 (audited fact, not a design choice): **there is no code path by which Fabric could approve, since OMEGA V2 exposes no approval endpoint to any caller other than the host's own local process.** Fabric requesting a high-impact action produces exactly the same `PENDING_APPROVAL → (host operator clicks ALLOW/DENY on that machine) → EXECUTED|DENIED` sequence as the existing UI does today. No `fabricApprove(...)`, no `fabricConfirmLocally(...)`, no simulated approval — these would require a network-reachable approval route that does not exist and per the OMEGA V2 Phase 5 report's own invariant table (`Remote self-approval: 0`) must never be added.

## 15. STOP model (design)

Per mission §25–26, Fabric exposes STOP as **thin wrappers over existing OMEGA V2 primitives**, never a new authority:

| Fabric action (future) | Calls |
|---|---|
| `fabricStopOmegaView(fabricDeviceId)` | `stopOmegaOutboundView(sessionId)` |
| `fabricStopOmegaInteractive(fabricDeviceId)` | `stopOmegaOutboundInteractive(sessionId)` |
| `fabricStopOmegaSession(fabricDeviceId)` — the mission's "STOP OMEGA FOR THIS DEVICE" (§26) | `stopOmegaOutboundSession(sessionId)` — cascades VIEW+INTERACTIVE+ADMIN, matching what the button already does in the existing UI |

**No `GLOBAL SUPER STOP` mixing OMEGA and RASSILON** (§26, explicit prohibition): if a future "stop everything Fabric knows about for this device" action is ever proposed, it must be two **independent, sequential** calls — `fabricStopOmegaSession` and RASSILON's existing STOP-equivalent — each reporting its own PASS/FAIL, exactly the pattern Device Fabric V1's own architecture report already specified for its analyzed-but-undecided "STOP ALL DEVICE ACTIVITY" (§10 of that report: "appels séparés, séquentiels et indépendants... aucune super-session, aucun jeton commun"). This mission does not decide whether to build that combined button; it only reaffirms the constraint if one is ever proposed.

Remote STOP (host-initiated) requires no new Fabric code: Fabric's operation display simply reflects whatever `getOmegaOutboundSession`/the status poll already reports — `REMOTE_STOPPED` surfaces exactly like every other terminal status.

## 16. Audit model (design)

Per mission §48–49: a `fabric_audit`-equivalent event for OMEGA V2 routing carries `fabricDeviceId`, `agentType: 'OMEGA_V2_OUTBOUND'`, `agentDeviceId` (the `remoteDeviceId`), a semantic operation name (`VIEW_START`, `INTERACTIVE_START`, `ADMIN_REQUEST:<action>`, `STOP`, …), a safe status/result code, and a timestamp — the same shape already used for RASSILON's `FABRIC_ROUTE_*` events (§2). It never stores: screen frames, keystrokes, credentials, tokens, private keys, or full ADMIN read results (a `PROCESS_LIST` result, for instance, is never copied into Fabric's audit — only "ADMIN_REQUEST:PROCESS_LIST → EXECUTED" is).

**Audit source of truth stays with OMEGA V2** (§49): `omega_v2_audit` already records its own closed enum (`OUTBOUND_SESSION_CREATED`, `OUTBOUND_VIEW_STARTED`, `OUTBOUND_ADMIN_EXECUTED`, …) independently, exactly as RASSILON's `rassilon_audit` does today alongside Fabric's own `fabric_audit`. Fabric's event is a **correlation pointer** (`operationId`/`sessionId` reference), never a replacement or a duplicate copy of OMEGA's security-relevant detail.

## 17. Database impact (design, not applied)

**Preference: reuse the existing `fabric_agent_links` and `fabric_audit`/`fabric_operations` tables**, extending only their `CHECK` enums:

```
-- Conceptual, NOT applied in this mission:
-- fabric_agent_links.agent_type CHECK extended to include 'OMEGA_V2_OUTBOUND'
-- fabric_audit.agent_type / event_type CHECK extended with new safe event names
-- fabric_operations.agent_type CHECK extended; job_type-equivalent becomes the
--   closed OMEGA V2 action name (VIEW_START, INTERACTIVE_START, ADMIN:<enum>, STOP)
```

**New metadata fields acceptable per mission §56 examples** (`lastOmegaStatus`, `lastOmegaStatusAt`, `linkVersion`) — if Phase 2 needs a cached display value beyond what a live read provides, it should be exactly this shape: a **non-authoritative display cache**, timestamped, always superseded by a live OMEGA V2 read before any routing decision (§8.4's staleness rule applies identically to a persisted cache as to an in-memory one). No such field is added by this mission.

**Forbidden per mission §57**, confirmed impossible to accidentally introduce given §4's design: `omegaPrivateKey`, `omegaSessionToken`, `omegaApprovalToken`, `omegaBearerToken`, `omegaClientSecret` — none of these values exist in Fabric's data flow at any point in the design above; there is nothing to accidentally persist.

## 18. API design (conceptual, not implemented)

Mounted under the existing `/api/device-fabric/*` prefix, same guard as today (loopback + Host + Origin localhost + JSON + body limits):

```
GET  /api/device-fabric/devices/:id/omega-v2/status
POST /api/device-fabric/devices/:id/omega-v2/view/start
POST /api/device-fabric/devices/:id/omega-v2/view/stop
POST /api/device-fabric/devices/:id/omega-v2/interactive/start
POST /api/device-fabric/devices/:id/omega-v2/interactive/stop
POST /api/device-fabric/devices/:id/omega-v2/admin/:action   -- :action ∈ closed 9-value enum, checked server-side
GET  /api/device-fabric/devices/:id/omega-v2/admin/operations/:operationId
POST /api/device-fabric/devices/:id/omega-v2/stop
```

(Named `omega-v2` rather than reusing bare `omega` in the path, to keep the URL itself unambiguous about which link kind it targets — matching the `OMEGA_V2_OUTBOUND` agent-type naming in §5.2.)

Per mission §52: the `:action` route accepts **only** a path-segment value from the closed enum — never `body.command`/`body.script`/`body.executable`. Per mission §53–55: local-API-only, no new listener, no proxy of any kind (`GET /view/frame` is deliberately **not** proxied through Fabric — the existing `OmegaOutboundViewTab` component talks to `/api/omega/outbound/*` directly once it has a `sessionId`, per §11's reuse decision, so Fabric's API surface never needs to carry binary frame bytes at all).

**No implementation in this mission.**

## 19. UI design (conceptual, not implemented)

Per mission §36–38, within the existing `Settings → APPAREILS → <device card>` structure (already built, certified, frozen for OMEGA-V1/RASSILON — Device Fabric V1 §17/§18):

```
┌ PC Bureau ──────────────────────────────────── PARTIAL ──┐
│ OMEGA (V1 inbound)   [existing section, unchanged]        │
│ OMEGA V2 (outbound)  TRUSTED · fingerprint 3f9a…c21e       │
│   SUPPORTED  VIEW:YES  INTERACTIVE:YES  ADMIN:YES          │
│   AUTHORIZED VIEW:YES  INTERACTIVE:YES  ADMIN:YES          │
│   AVAILABLE  UNKNOWN (no active session — connect to check)│
│   [Start VIEW]  [Start INTERACTIVE]*  [ADMIN...]*  [STOP]  │
│   * disabled until a session/VIEW is active, same gating   │
│     OmegaOutboundViewTab already enforces                  │
│ RASSILON              [existing section, unchanged]        │
└─────────────────────────────────────────────────────────┘
```

- A **fourth, clearly separate section**, never merged into the existing `OMEGA` (V1) card block — satisfying §36's "ne pas fusionner les permissions" directly, and avoiding exactly the confusion §1 of this report identifies.
- High-impact ADMIN actions visually distinct (red border, confirmation dialog naming the exact device) — reusing `OmegaOutboundAdminPanel.tsx`'s already-certified pattern verbatim, not reinventing it.
- No "DEVICE TRUSTED" single global badge (§37) — OMEGA V2's trust/SUPPORTED/AUTHORIZED/AVAILABLE stay a separate block from RASSILON's and from OMEGA V1's, exactly like the existing card already keeps OMEGA and RASSILON separate.
- All explicit-click gating, confirmation-dialog, XSS-text-only-rendering and "API unreachable → UNKNOWN everywhere" rules from Device Fabric V1's UI (§17/§18 of that report, H5/H6/H8 hardening from Phase 4) apply identically to the new section — no new UI risk class is introduced.

**No implementation in this mission.**

## 20. Threat model

| Threat (mission §67) | Analysis | Mitigation (design) |
|---|---|---|
| Wrong-device routing | Every typed call is scoped to a `sessionId` OMEGA V2 itself bound to one device at connect time (§6.1); no device list ever reaches OMEGA V2 from Fabric | structural, not policy: no OMEGA V2 function accepts more than one target |
| Stale link | `linkState` computed at read time, re-compared against a live re-read of `omega_v2_outbound_trust` before use (§6.2 step 2–3) | `OMEGA_LINK_STALE`, fail closed |
| Link substitution | see TOCTOU analysis §6.3 | re-read-immediately-before-use pattern |
| TOCTOU | §6.3 | established sessions immune by construction; pre-connect window mitigated by double-read |
| Fabric confused deputy | Fabric holds no OMEGA V2 authority to lend (§4); every call is the same loopback-caller identity the existing UI already uses | unchanged from V1's own confused-deputy analysis (§19 of the V1 architecture report), extended: OMEGA V2 re-derives everything from its own store on every call, same as RASSILON |
| Cross-agent trust reuse | §7: three-way fingerprint check extended from the existing two-way check | `cross_agent_key_reuse` rejection, symmetric across all three agent types |
| Cross-agent credential reuse | OMEGA V2 keys (`omega-v2-role-key:*`), OMEGA V1 keys (`omega-device-key:*`) and RASSILON keys (`rassilon-device-key:*`) are three disjoint DPAPI namespaces; Fabric imports none of them | structural (no shared code path), same guarantee V1 already has for the OMEGA/RASSILON pair |
| Permission escalation | Fabric never writes `permission`; OMEGA V2 clamps to `trust.maxPermission` server-side on every `connectOmegaDevice` call, independent of what Fabric requests | OMEGA V2's own existing `permissionAllowed()` check, unmodified |
| VIEW → INTERACTIVE escalation | `startOmegaOutboundInteractive` already requires an active VIEW session and a session `permission` ≥ `INTERACTIVE`; Fabric cannot skip this because it calls the same typed function the UI does | inherited from OMEGA V2, unmodified |
| INTERACTIVE → ADMIN escalation | ADMIN reads/requests require `session.permission === 'ADMIN'` exactly, checked host-side on every request (Phase 5 report §"ADMIN permission model") | inherited, unmodified |
| Fabric self-approval | §3.6/§14: no approval endpoint reachable from Fabric or any network caller | structural absence, not a policy |
| Session hijack | `sessionId` alone authorizes nothing (every OMEGA V2 request is Ed25519-signed per-call by the controller's private key, which Fabric never holds — Fabric can only *ask this PC's own OMEGA V2 controller identity* to sign, exactly like the existing UI); an attacker who obtained a bare `sessionId` string still cannot forge a signed request | inherited from OMEGA V2 Transport certification, unmodified |
| Replay | every OMEGA V2 call is nonce+timestamp+body-hash signed and replay-checked host-side; Fabric adds no new transport, so adds no new replay surface | inherited, unmodified |
| Certificate change | `connectOmegaDevice` fails closed (`TLS_IDENTITY_MISMATCH`) on any pin/SAN mismatch; Fabric never updates a pin automatically (mission §41) — a changed certificate requires the user to re-register the trust via OMEGA V2's own UI, exactly as today | inherited, unmodified; Fabric shows a warning, never silently proceeds |
| Revocation race | if `revokeOmegaOutboundHost` runs concurrently with an in-flight Fabric-initiated call, the in-flight call either completes (already past its own auth checks) or the *next* call re-reads the revoked trust and fails `OMEGA_REVOKED` — no window where a revoked host silently keeps being routable indefinitely | same guarantee OMEGA V2 already gives any caller |
| STOP race | `stopOmegaOutboundSession` is called from Fabric's STOP wrapper exactly as from the UI; OMEGA V2's own STOP-is-authoritative design (§3.5) applies identically | inherited |
| Network drop | OMEGA V2's own session-monitor already fails the session closed and does not reconnect (`OMEGA_V2_OUTBOUND` invariant table: `Automatic reconnect: 0`); Fabric inherits this with 0 new code | inherited |
| Status spoofing / availability lying | AVAILABLE is only ever set from a live OMEGA V2 read, never from Fabric-side state (§8.2); an attacker controlling only Fabric's DB (already outside the V1 threat model per Device Fabric V1 §18 "Falsification de la base Fabric") could at most mislabel a link's *display*, never make an actual `connectOmegaDevice` call succeed against a device it doesn't control | same residual-risk classification as V1 |
| Malicious OMEGA result | every typed VIEW/ADMIN result is already schema-validated and signature-bound by OMEGA V2 itself before Fabric would ever see it (frame PNG structural check, ADMIN result exact-key-set validation — Phase 3/5 reports) | inherited, unmodified |
| Oversized result | OMEGA V2 already bounds every response (8 MiB frames, 96 KiB ADMIN read results, 64/160 KiB envelopes); Fabric adds no unbounded pass-through | inherited |
| XSS via device name/status/error | same discipline as the existing Fabric card (§19): React-text-only rendering, control/bidi stripping, truncation, applied identically to the new section; error codes normalized to the closed set in §16/mission §35, never a raw message | design carried forward, to implement in Phase 2+ |

## 21. Test plan (Phase 2+, not run)

Mirrors the RASSILON routing test plan's proven shape (Device Fabric V1 §10 "test-device-fabric-routing.mjs", 28/28) with OMEGA V2 substituted:

**Link/resolution**: exact fabric→omega mapping; unlinked device → `OMEGA_NOT_LINKED`; stale link (trust missing/fingerprint changed) → `OMEGA_LINK_STALE`; revoked OMEGA host → `OMEGA_REVOKED`; missing OMEGA identity → `OMEGA_NOT_LINKED`; wrong fingerprint at link time → rejected at link creation (existing `linkAgent` gate, extended); wrong-device response (a host signs as itself but the response's bound device differs) → `INVALID_RESPONSE` (inherited from OMEGA V2's own `validateOmegaOutboundFrame`/`verifyOmegaOutboundAdminPayload`); **no fallback** — device A linked+offline, device B linked-elsewhere+available → A `OMEGA_UNAVAILABLE`, B **0 calls, 0 connect attempts** (mission §61, mirrors the RASSILON "B: 0 job" proof pattern exactly).

**VIEW**: route success (session created, frame reachable via the existing UI path); permission denied (`trust.maxPermission = 'VIEW'`, INTERACTIVE/ADMIN requests rejected before any OMEGA call, and rejected again by OMEGA itself if somehow reached).

**INTERACTIVE**: route success (requires active VIEW, mirrors OMEGA V2's own gate); permission denied.

**ADMIN**: read-only success (all 5, exact schema); high-impact requires approval (request → `PENDING_APPROVAL`, no execution without the host's own local decision, mirrored via OMEGA V2's existing mock-approval test harness — never a real prompt or real action, per mission §15); unknown action rejected (enum check before any dispatch, `400`, 0 calls).

**STOP / lifecycle**: STOP (session/view/interactive, cascading exactly as OMEGA V2 itself defines); session expiry (Fabric's next read reflects `SESSION_EXPIRED` with 0 special-casing); remote STOP (reflected within one status-poll cycle); network drop (session ends, 0 auto-reconnect, Fabric's display reflects `OMEGA_UNAVAILABLE`); link changed during operation (§6.3's double-read mitigation, explicitly tested: change the link between the two reads, assert `OMEGA_LINK_STALE` and 0 `connectOmegaDevice` call with the new target).

**Cross-agent/isolation** (mission §60): Fabric deletion preserves OMEGA V2 trust (`fabric_devices`/`fabric_agent_links` row removed, `omega_v2_outbound_trust` row byte-identical before/after — same instantaneous-diff test pattern as the existing RASSILON unlink test); OMEGA V2 revocation preserves RASSILON (unaffected table); RASSILON revocation preserves OMEGA V2 (unaffected table); a RASSILON session/credential presented to an OMEGA V2 route → rejected (structurally impossible to even construct, since Fabric never reads a RASSILON credential to build an OMEGA V2 call — test asserts the code path, not just the outcome); OMEGA V2 credential used as RASSILON → same; Fabric metadata (link row, display name) used as an auth input anywhere → rejected (asserted by the same static-audit-forbidden-imports pattern already enforced for OMEGA/RASSILON, extended to forbid any `omega-outbound-identity.js`/`secret-store.js` import from Fabric code).

**Static audit** (extends `test-device-fabric-static-audit.mjs`): no import of `omega-outbound-identity.js`'s signing functions, `secret-store.js`, or any OMEGA V2 approval-decision function (there is none to import, confirming absence); single call site per OMEGA V2 typed function, matching the existing "single dispatch site" pattern already enforced for `dispatchRassilonRemoteJob`; no voice/CommandBar/agent/scheduler import of the new Fabric OMEGA V2 module.

## 22. Two-process harness plan

Per mission §62: reuse OMEGA V2's own certified two-process TLS harness infrastructure (`test-omega-outbound-harness.mjs` / `test-omega-outbound-admin-harness.mjs`, both already proving real TLS+SAN+pin+mutual-auth end-to-end with a recorder/mock executor on the host side) rather than building a new one.

```
Process A: this Docteur process, with Device Fabric's OMEGA V2 router
           (Phase 2+ code) calling OMEGA V2's real controller functions
Process B: the existing omega-outbound-server-child.mjs fixture
           (real TLS listener, recorder VIEW/INTERACTIVE/ADMIN providers —
           already proven safe: 0 real Windows action reachable)
```

Test shape: Fabric resolves a link pointing at B's real `remoteDeviceId` and real pinned certificate (registered via `registerOmegaOutboundHost` exactly as the harness already does), then calls the Phase 2+ Fabric router functions instead of calling `connectOmegaDevice`/`startOmegaOutboundView`/etc. directly — proving the **entire stack** (Fabric resolution → OMEGA V2 typed call → real TLS → real signed protocol → recorder result → Fabric's normalized response) end to end, with **no second physical PC required** (mission §40), exactly as OMEGA V2's own Phase 2–5 certifications and Device Fabric's own RASSILON routing certification (13/13 real-process harness) already established as sufficient evidence.

## 23. RASSILON regression plan

No RASSILON code, route, table or test is touched by this design. Phase 2+ implementation must re-run the existing RASSILON regression suite unchanged (252/253 baseline, 1 historical Ollama skip) and the existing RASSILON-routing-specific Fabric tests (`test-device-fabric-routing.mjs`, 28/28) to confirm 0 behavior change — the same "0 fichier modifié" discipline every prior Device Fabric phase already proved is achievable.

## 24. Device Fabric V1 regression plan

All existing Device Fabric V1 tests (84/84 backend, 79/79 browser, 13/13 real-process) must remain green unmodified. The only schema change contemplated (§17) is an **additive `CHECK` enum extension** on already-existing tables — never a destructive migration, following the exact precedent Phase 3 already set for `fabric_audit`'s one-time non-destructive `CHECK` migration (Device Fabric V1 §7 of the RASSILON routing report: "une base Phase 2... est reconstruite une fois... tous les ids et lignes conservés").

## 25. OMEGA V2 regression plan

**0 OMEGA V2 file is proposed to change.** Every capability this design needs already exists as a typed function or a local route (§3). If Phase 2+ discovers a genuine minimal-interface gap (none identified in this audit), it must be raised as its own explicit, separately-justified change to OMEGA V2 — never assumed here. The full OMEGA V2 regression suite (77/77 backend, 116/116 combined browser across VIEW/INTERACTIVE/ADMIN, per the Final Certification report) must remain green unmodified.

## 26. Roadmap (not started)

- **Phase 2**: read-only OMEGA V2 status + exact-routing foundation — the `OMEGA_V2_OUTBOUND` link kind (§5.2), the resolution flow (§6.2) wired to `GET .../omega-v2/status` only, no action routing yet. Test plan: §21's link/resolution subset.
- **Phase 3**: VIEW routing (§11).
- **Phase 4**: INTERACTIVE routing (§12).
- **Phase 5**: ADMIN routing + STOP (§13, §15).
- **Phase 6**: UX (§19) + hardening + certification + freeze, mirroring Device Fabric V1's own Phase 4 hardening pass (state-machine enforcement, staleness/freshness UI, XSS closure) and OMEGA V2's own Phase 6 final-certification discipline (stability measurement, temp-artifact audit, full regression).

None of these phases is started by this mission.

## 27. Limitations of this analysis

1. **§8.3's "probe cost" question is flagged, not resolved.** OMEGA V2 has no lightweight availability ping; a Phase 2 design decision is needed on whether "check availability" implies a real (rate-limited) connect attempt or stays permanently UNKNOWN until the user explicitly starts a session.
2. **The three-way cross-agent-key-reuse check (§7) is a straightforward extension of existing code but is unverified until Phase 2 implements and tests it** — this report asserts it is mechanically identical to the existing two-way check, not that it has been built.
3. **No second physical machine was used for this audit** (none was needed: this is a read-only architecture mission). The two-process harness plan (§22) is unimplemented and unverified until Phase 2+.
4. **This report cannot see future OMEGA V2 changes.** If a later, separate OMEGA V2 mission changes the typed-function surface audited in §3, this architecture must be re-validated against the new certified state before Phase 2 begins.
5. **The UI mockup in §19 is illustrative**, not a finished design; exact copy, layout and error-string wording are Phase 6 decisions.
6. **OMEGA V2's own known limitations are inherited unchanged**: no real second-device test yet exists for OMEGA V2 itself (NOT_RUN, per its Final Certification), real Windows input smoke NOT_RUN, real approval-prompt display NOT_RUN. None of these block Phase 2+ (Device Fabric V1 reached PASS/FROZEN despite equivalent RASSILON-side NOT_RUN items), but Phase 2+ must not claim a stronger guarantee for the OMEGA V2 path than OMEGA V2 itself claims.
7. **Windows-first**, inherited from every underlying agent.

## 28. Verdict

Criteria (mission §70):

- OMEGA V2 stays frozen ✔ (0 file proposed to change, §25)
- RASSILON stays frozen ✔ (0 file proposed to change, §23)
- Device Fabric V1 can evolve without destructive migration ✔ (additive `CHECK` extension only, §17/§24)
- Exact target enforceable ✔, structurally stronger than RASSILON's own guarantee (§6.1)
- Device fallback = 0 ✔ (§6.1: no OMEGA V2 function accepts more than one target — nothing to fall back *to*)
- Fabric credentials = 0 ✔ (§4)
- Trust inheritance = 0 ✔ (§4, §7)
- Permission inheritance = 0 ✔ (§4, §20 "permission escalation" row)
- OMEGA revalidates authorization ✔ (§6.2 step 4–5, every call independently re-checked)
- STOP semantics preserved ✔ (§15, thin wrappers only)
- High-impact approval preserved ✔ (§3.6/§14, structurally — no approval route exists to bypass)
- No generic RPC/router ✔ (§13, §18 — closed enum only, no raw-args function)
- No autonomous control ✔ (§19's design carries forward the existing "explicit click only" discipline; no voice/agent/scheduler path is proposed anywhere in this design)
- Test plan complete ✔ (§21–22, mirrors the proven RASSILON-routing test shape)

**Verdict: READY_FOR_PHASE_2**

---

```
DOCTEUR DEVICE FABRIC V2 PHASE 1 CHECKPOINT

Git safety prerequisite : PASS
OMEGA V2 certified/frozen : PASS
Device Fabric V1 preserved : PASS
RASSILON V1 preserved : PASS
Current Fabric architecture audited : PASS
Current OMEGA V2 APIs audited : PASS
Fabric → OMEGA link model : PASS
Exact omegaDeviceId resolution : PASS
Device fallback : 0
Automatic relinking : 0
IP/hostname security identity : 0
Fabric OMEGA private keys : 0
Fabric OMEGA tokens : 0
Fabric OMEGA session secrets : 0
Fabric OMEGA approvals : 0
Trust inheritance : 0
Permission inheritance : 0
Cross-agent auth reuse : 0
OMEGA security revalidation : PASS
Status model : PASS
Availability honesty : PASS
Stale link handling : PASS
TOCTOU mitigation design : PASS
VIEW routing design : PASS
INTERACTIVE routing design : PASS
ADMIN routing design : PASS
High-impact approval preserved : PASS
STOP routing design : PASS
OMEGA/RASSILON revocation separation : PASS
Fabric delete preserves agent trust : PASS
Generic router : 0
Generic RPC : 0
Generic network proxy : 0
Remote shell : 0
Arbitrary command : 0
File transfer : 0
Clipboard : 0
Credential access : 0
Autonomous remote control : 0
Voice-triggered routing : 0
Agent-triggered routing : 0
Cloud relay : 0
Internet exposure : 0
New listening port : 0
Database design : PASS
API design : PASS
UI design : PASS
Threat model : PASS
Test plan : PASS
Two-process harness plan : PASS
Files changed : reports/DEVICE_FABRIC_V2_OMEGA_ROUTING_ARCHITECTURE_2026-09.md
Known limitations : probe-cost design question open (§27.1) ; three-way cross-agent check unverified until built (§27.2) ; two-process harness unimplemented (§27.3) ; UI mockup illustrative only (§27.5) ; inherits OMEGA V2's own NOT_RUN items (real second device, real input smoke, real approval-prompt display) without claiming a stronger guarantee (§27.6)
Verdict : READY_FOR_PHASE_2
```

**STOP: Phase 2 is not started. OMEGA V2, RASSILON and Device Fabric V1 are unmodified. No route, table or UI was added.**
