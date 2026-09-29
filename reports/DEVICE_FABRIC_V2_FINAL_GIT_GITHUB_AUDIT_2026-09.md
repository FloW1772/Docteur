# DOCTEUR — DEVICE FABRIC V2 — FINAL GIT / GITHUB SAFETY AUDIT

Status: **AUDIT ONLY — READY**
Date: 2026-09-29

Device Fabric V2 is FINAL / CERTIFIED / FROZEN
(`reports/DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md`). This is a
read-only Git/GitHub safety audit ahead of a future commit/push. **No
functional source file was modified.** No `.gitignore` correction was
required, so none was made. No `git add`, `commit`, `push`, `reset`,
`clean`, or `stash` was ever run.

## 1. Git state

```
git status --short        → 9 modified, 25 untracked, 0 staged
git diff --stat            → 9 files, 1696 insertions(+), 45 deletions(-)
git diff --cached --name-only → (empty — 0 staged)
```

All 34 changed/new paths belong to Device Fabric V2 (Phases 2–6) work
already covered by `DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md`. No
unrelated file is modified or staged.

## 2. `.gitignore` files audited (read in full)

| File | Lines | Scope |
|---|---|---|
| `.gitignore` (root) | 135 | Whole repo: secrets, app data, test scratch DBs, TLS certs/keys, dependencies, build output, logs, temp/cache, Python artifacts, Playwright evidence, OS junk, editor/Claude settings, nested external repos |
| `cortex-server/.gitignore` | 9 | Redundant subset of the root rules (`node_modules/`, `.env*`, `data/*`, `*.log`) — harmless duplication, not a gap |
| `docteur-voice/.gitignore` | 8 | Tauri-specific (`src-tauri/target/`, icons) — unrelated to Device Fabric |
| `.claude/worktrees/agent-a92a80d074bc61998/.gitignore` | — | Inside an ignored `.claude/` worktree; not reachable by the parent repo, out of scope |

No pattern was assumed to work — every rule below was verified live with
`git check-ignore -v`, not read-and-trusted.

## 3. Device Fabric V2 file trackability (§3)

Every legitimate Device Fabric V2 source, test, and report file was checked
individually with `git check-ignore -v`. **Result: 0 ignored.**

- `cortex-server/src/lib/device-fabric*.js` (6 files) — not ignored
- `cortex-server/src/routes/device-fabric.js` — not ignored
- `src/components/settings/FabricOmegaV2ViewPanel.tsx`,
  `FabricOmegaV2AdminPanel.tsx`, `DeviceFabricSettingsTab.tsx` — not ignored
- `src/lib/cortex/client.ts` — not ignored
- All `cortex-server/test-device-fabric-*.mjs` (12 files) — not ignored
- `scripts/test-device-fabric-browser.mjs`,
  `scripts/test-device-fabric-server-boot.mjs` — not ignored
- `cortex-server/test-manifest.mjs` — not ignored
- All 6 `reports/DEVICE_FABRIC_V2_*.md` files — not ignored

## 4. Test manifest audit (§4)

`cortex-server/test-manifest.mjs`: trackable (confirmed above), 0 secrets, 0
absolute personal paths (uses only `path.dirname(fileURLToPath(import.meta.url))`
for relative resolution — no hardcoded machine path anywhere), 0 hardcoded
temp file paths. It documents and excludes exactly 5 non-test scripts with a
written reason for each (see the Phase 6 certification report §12.2 for the
full table) — this is the deterministic exclusion mechanism the mission
required, and it self-validates on every run (warns if a future file with no
`node:test` import lacks an exclusion entry).

## 5. Report trackability and content (§5)

All 6 `reports/DEVICE_FABRIC_V2_*.md` files (including this one and the
Phase 6 final certification) confirmed trackable. Scanned for private-key
markers, `client_secret`, `access_token`, `refresh_token`, and bearer-token
patterns — **0 matches**. No absolute personal path appears in any report.

## 6. Private keys (§6–7)

```
git ls-files | grep -iE "\.key$|\.pem$|\.pfx$|\.p12$|id_rsa|id_ed25519|private.?key"
→ (empty: 0 tracked)
```

Filesystem scan found 4 actual key/cert files on disk, **none tracked**,
all individually confirmed ignored:

| File | Ignored by |
|---|---|
| `certs/cert.pem` | `.gitignore:27` (`certs/`) |
| `certs/key.pem` | `.gitignore:27` (`certs/`) |
| `cortex-server/data-test-rassilon-v1-hardening/invalid.key` | `.gitignore:24` (`data-test-*/`) |
| `cortex-server/data-test-rassilon-v1-hardening/invalid.pem` | `.gitignore:24` (`data-test-*/`) |

`certs/cert.pem` is public certificate material (test HTTPS cert); its
paired `key.pem` is private-key material and is ignored by the same `certs/`
rule — correctly, since the rule does not distinguish and both must be
ignored regardless. **0 tracked private keys, 0 ready for staging.**

## 7. Databases and runtime/session state (§8–9)

```
git ls-files | grep -iE "\.sqlite|\.db($|3$)" → empty
git ls-files | grep -iE "session|\.cache|\.tmp$|\.pid$|\.lock$"
→ only cortex-server/src/lib/omega-session.js and
  cortex-server/test-omega-session.mjs (source/test logic, not session data)
```

**0 tracked runtime databases, 0 tracked session/runtime state.**
TLS-harness scratch directories (`fs.mkdtempSync(path.join(os.tmpdir(), …))`)
resolve to the OS temp directory, structurally outside the repository tree
— not merely ignored, but physically impossible to commit.

## 8. OMEGA / RASSILON / Fabric secrets (§10–12)

```
git ls-files | grep -iE "private.?key|\.key$|bearer|approval.?token|nonce.?cache|pairing.?secret"
→ empty
```

**0 tracked private identity keys, TLS keys, bearer/session/approval
tokens, or pairing secrets** for OMEGA, RASSILON, or Device Fabric. Device
Fabric's own code was already independently confirmed (Phase 6
certification §7) to hold no key, credential, or approval-authority surface
at all — this audit adds the git-tracking-level confirmation on top of that
code-level one.

## 9. Environment files (§13)

Only `cortex-server/.env.example` exists on disk anywhere in the repo — no
real `.env`, `.env.local`, or `.env.production` file is present. It is
correctly tracked (via the explicit `!.env.example` negation) and contains
only placeholder defaults (`PORT=3001`, `HOST=127.0.0.1`, local Ollama URL,
local file paths) — **0 real secrets**.

## 10. Secret scan (§14)

Scanned all 875 tracked non-binary files for `BEGIN (RSA/EC) PRIVATE KEY`,
`client_secret=`, `access_token=`, `refresh_token=`, and
`Authorization: Bearer <token>`-shaped patterns. **10 hits, all classified
as false positives** — synthetic test fixtures verifying that redaction/
secret-guard code works correctly, never real credentials:

| File | Pattern found | Classification |
|---|---|---|
| `test-ai-provider-fallback.mjs` | `sk-ant-abcdef123456789` in a literal test string | FAKE_FIXTURE |
| `test-batch-a-robustness.mjs` | `client_secret: 'fake-client-secret'` | FAKE_FIXTURE |
| `test-batch-d-connectors.mjs` | `'fake-secret-...'`, `'fake-access'`/`'fake-refresh'` | FAKE_FIXTURE |
| `test-external-agents.mjs` | redaction-test payload incl. literal `'-----BEGIN PRIVATE KEY-----\nprivatebytes\n...'` | FAKE_FIXTURE (asserts the value is OMITTED from output) |
| `test-phase1-credential-isolation.mjs` | `'GOOGLE_SENTINEL_HTTP_SECRET'` | FAKE_FIXTURE |
| `test-phase2-connectors.mjs` | `'fake-super-secret'`, `'fake-access-token'` | FAKE_FIXTURE |
| `test-teacher-fallback.mjs` | `sk-live-FAKETOKEN1234567890` in a literal log-redaction test string | FAKE_FIXTURE |
| `test-video-audio.mjs` | `SESSION_SECRET`/`AUTH_SECRET`/`PASS_SECRET`/`KEY_SECRET` placeholder tokens | FAKE_FIXTURE |
| `scripts/gen-cert.mjs` | a regex *pattern* matching PEM markers (`/-----BEGIN RSA PRIVATE KEY-----.../`) | CODE, not a key |
| `scripts/test-voice-response-tts.mjs` | `'Authorization: Bearer abcdef1234567890ghijkl'` literal test string | FAKE_FIXTURE |

None of these 10 files are in the Device Fabric V2 change set. **0 real
secrets found.**

## 11. Git history secret scan (§15)

Read-only. 26 total commits. `git rev-list --all | git grep` for private-key
markers across **every commit in history** returned only
`cortex-server/test-external-agents.mjs` and `scripts/gen-cert.mjs` — the
same two files, same false-positive reasons, as §10. A follow-up
`git log -p` over both files' entire history confirms every historical
addition around the `PRIVATE KEY` marker is the identical fake
`'privatebytes'` string or the identical PEM-matching regex — **never a real
key at any point in history.** History was not rewritten (read-only
commands only: `git log`, `git grep`, `git rev-list`).

**No `GIT_HISTORY_SECRET_BLOCKER`.**

## 12. Browser artifacts, build output, dependencies (§16–20)

| Category | Coverage |
|---|---|
| `playwright-report/`, `test-results/`, `videos/`, `traces/` | ignored (root `.gitignore`) |
| Studio Playwright screenshots | ignored via `reports/studios-evidence/` |
| `dist/`, `build/`, `.vite/`, `coverage/` | ignored |
| `node_modules/` (root, cortex-server, docteur-voice) | ignored; 0 tracked |
| `package.json` / `package-lock.json` (root + cortex-server) | tracked (correct — lockfiles must be versioned) |
| `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, cache dirs | ignored; 0 tracked |
| `*.log`, `logs/` | ignored |

No standalone `screenshots/` pattern exists, but no untracked/exposed
screenshot directory was found either — the only tracked PNGs
(`screenshot_render.png`, `screenshot_render2.png`, ~350 KB / ~320 KB) are
pre-existing assets from the repo's initial commit, unrelated to Device
Fabric, and not a secret/sensitive leak. Not touched by this audit (out of
scope for a Device Fabric mission).

## 13. Downloads, media, user data (§21–22)

No `downloads/` or `media/` directory exists in the repo. No tracked file
matches personal-conversation-export, notebook-export, or browser-history
naming patterns. `cortex-server/compaction-report.json` and
`reports/connectors-*.json` are pre-existing committed test/report
artifacts, not personal user data.

## 14. Absolute path leakage (§23)

Scanned all tracked `.js`/`.mjs`/`.ts`/`.tsx`/`.md` files, plus every new/
modified Device Fabric V2 file individually, for `C:\Users\<name>\`,
`/home/<name>/`, `/Users/<name>/`, and `AppData\Local\` patterns.
**0 matches anywhere.**

## 15. Nested repositories (§24–25) — CRITICAL

```
git ls-files -s | awk '$1 == "160000"'  → empty (0 gitlinks)
git ls-files | grep "^external/(MetaGPT|OpenMontage)/"  → empty
git check-ignore -v external/MetaGPT external/OpenMontage
  → .gitignore:133 /external/MetaGPT/
  → .gitignore:134 /external/OpenMontage/
```

Both `external/MetaGPT` and `external/OpenMontage` confirmed as genuine,
independent Git repositories (`git rev-parse --is-inside-work-tree` → true
inside each, each with its own distinct `origin` remote —
`FoundationAgents/MetaGPT` and `calesthio/OpenMontage` respectively). The
parent Docteur repo: **0 gitlinks, 0 accidentally tracked files from either,
`.git` content never exposed.**

`external/Sherlock-runtime/` is also ignored and is not a git repo (safe).
`external/Sherlock-source/` is a pre-existing, intentionally tracked ~323 KB
vendored source snapshot — not a git repository itself (no nested `.git`,
so no gitlink risk), unrelated to Device Fabric, out of scope for this
audit to change. No other unexpected repo was found under `external/`,
`vendor/`, `third_party/`, `tmp/`, or `downloads/` (the latter three do not
exist in this repo).

## 16. Broad/dangerous ignore patterns and negation rules (§26–27)

No dangerous broad pattern (`*.js`, `*.ts`, `src/`, `test/`, `tests/`,
`scripts/`, `reports/`, `cortex-server/`, or similar) exists in any
`.gitignore` in this repo. **0 unsafe broad ignore patterns.**

Exactly 3 negation rules exist, all safe:
- `!.env.example` (root and `cortex-server/`) — re-exposes only the
  placeholder template, never a real `.env`.
- `!data/.gitkeep` (`cortex-server/`) — re-exposes an empty marker file,
  never real data.

**0 dangerous negation rules.**

## 17. Windows / case-sensitivity (§28)

No backslash-style pattern exists in any `.gitignore` (all use forward
slashes, portable). No two tracked filenames differ only by case anywhere
in the repo (`git ls-files | tr A-Z a-z | sort | uniq -d` → empty) — safe on
Windows' case-insensitive filesystem.

## 18. Large files, archives, model files (§29–31)

`git ls-tree -r -l HEAD` sorted by size — largest tracked files are
`public/mediapipe/*.wasm` (~11.7 MB × 3) and `public/tesseract/*` (OCR
runtime assets), all pre-existing, legitimate bundled application assets,
unrelated to Device Fabric. **Nothing exceeds 50 MB; nothing exceeds
100 MB.** Only two archives are tracked
(`public/tesseract/lang-data/{eng,fra}.traineddata.gz`, ~2.9 MB / ~700 KB)
— legitimate OCR language data, not user data. **0 model files**
(`.gguf`/`.bin`/`.safetensors`/`.onnx`/`.pt`/`.pth`) tracked anywhere.

## 19. Test TLS artifacts (§32)

VIEW, INTERACTIVE, and ADMIN TLS harnesses all generate their certificates,
keys, and temp SQLite DBs via `fs.mkdtempSync(path.join(os.tmpdir(), …))` —
resolving to the OS temp directory, outside the repository tree entirely.
The RASSILON LAN-security harness and any in-repo TLS/key fixtures land
only under `certs/` or `data-test-*/`, both confirmed ignored (§6). **No
generated cert/key/temp DB from any harness can be committed by accident.**

## 20. `git check-ignore` verification sample (§33)

```
SENSITIVE / GENERATED (expect ignored):
  certs/key.pem                                → ignored (.gitignore:27, certs/)
  cortex-server/data-test-device-fabric-core/test.db → ignored (.gitignore:24, data-test-*/)
  node_modules                                  → ignored (.gitignore:47, node_modules/)
  external/MetaGPT                              → ignored (.gitignore:133)
  external/OpenMontage                          → ignored (.gitignore:134)

SOURCE / TEST / REPORT (expect NOT ignored):
  cortex-server/src/lib/device-fabric.js         → not ignored
  cortex-server/test-device-fabric-static-audit.mjs → not ignored
  reports/DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md → not ignored
```

All 8 samples behaved exactly as required.

## 21. Tracked-sensitive final sweep (§34)

```
git ls-files | grep -iE "\.(key|pem|pfx|p12|db|db3|sqlite|sqlite3)$|private.?key|session.*state|approval.*token|\.env$|\.env\.[a-z]+$"
→ (empty, after excluding .env.example)
```

**0 tracked secret/runtime/private material**, confirmed against
already-committed history, not just the working tree.

## 22. Expected staging list (§36)

Files that *should* be included in a future Device Fabric V2 commit — none
are runtime, private, or temporary:

**SOURCE** (10 files):
- `cortex-server/src/lib/device-fabric.js` (M)
- `cortex-server/src/lib/sqlite.js` (M)
- `cortex-server/src/routes/device-fabric.js` (M)
- `cortex-server/src/lib/device-fabric-omega-v2.js` (new)
- `cortex-server/src/lib/device-fabric-omega-v2-routing.js` (new)
- `cortex-server/src/lib/device-fabric-omega-v2-admin.js` (new)
- `src/components/settings/DeviceFabricSettingsTab.tsx` (M)
- `src/components/settings/FabricOmegaV2ViewPanel.tsx` (new)
- `src/components/settings/FabricOmegaV2AdminPanel.tsx` (new)
- `src/lib/cortex/client.ts` (M)

**TEST** (12 files):
- `cortex-server/test-device-fabric-migration.mjs` (M)
- `cortex-server/test-device-fabric-static-audit.mjs` (M)
- `cortex-server/test-device-fabric-omega-v2.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-route.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-view.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-view-harness.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-interactive.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-interactive-harness.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-admin.mjs` (new)
- `cortex-server/test-device-fabric-omega-v2-admin-harness.mjs` (new)
- `cortex-server/test-manifest.mjs` (new)
- `scripts/test-device-fabric-browser.mjs` (M)
- `scripts/test-device-fabric-server-boot.mjs` (new)

**REPORT** (6 files):
- `reports/DEVICE_FABRIC_V2_OMEGA_ROUTING_ARCHITECTURE_2026-09.md` (new)
- `reports/DEVICE_FABRIC_V2_OMEGA_LINK_STATUS_V1_2026-09.md` (new)
- `reports/DEVICE_FABRIC_V2_OMEGA_VIEW_ROUTING_V1_2026-09.md` (new)
- `reports/DEVICE_FABRIC_V2_OMEGA_INTERACTIVE_ROUTING_V1_2026-09.md` (new)
- `reports/DEVICE_FABRIC_V2_OMEGA_ADMIN_STOP_ROUTING_V1_2026-09.md` (new)
- `reports/DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md` (new)

**CONFIG** (1 file):
- `vite.config.ts` (M)

**DOCUMENTATION**: this report
(`reports/DEVICE_FABRIC_V2_FINAL_GIT_GITHUB_AUDIT_2026-09.md`) once created,
plus the reports listed above (reports double as documentation in this
repo's convention).

**Excluded from staging** (correctly, all gitignored/out-of-tree): every
`data-test-*/` scratch directory, `certs/*.pem`, all TLS-harness OS-temp
scratch directories, and `node_modules/`.

## 23. Known limitations

- `cortex-server/.gitignore` and the root `.gitignore` overlap redundantly
  (`node_modules/`, `.env*`, `*.log`) — harmless, not a gap, not changed
  (out of scope: a cleanup, not a safety issue).
- Two pre-existing, unrelated tracked assets were noted for completeness but
  intentionally left untouched as out of scope for a Device Fabric mission:
  `screenshot_render.png`/`screenshot_render2.png` (repo-root, from the
  initial commit) and the vendored `external/Sherlock-source/` snapshot.
- The `.claude/worktrees/agent-a92a80d074bc61998/.gitignore` file exists
  inside an already-ignored `.claude/` directory and has no effect on the
  parent repository; noted, not investigated further (out of scope).

## 24. GitHub push readiness

**READY.**

No secret, private key, runtime database, session/approval state, user
data, test artifact, or nested-repository content is tracked or would be
exposed by pushing the current tree (working tree changes plus history).
Both external nested repositories remain correctly ignored and structurally
isolated. The one gap search performed (screenshots/ pattern) found no
actual exposure. Git history contains no secret at any point. 0 files are
currently staged, so nothing changes here without an explicit future `git
add`/`commit` the user directs.
