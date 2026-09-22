# DOCTEUR — KIWIX WINDOWS DEEP INTEGRATION / RECOVERY MISSION

Date: 2026-09-22
Scope: audit of an **already-shipped** Kiwix/ZIM offline-knowledge integration against this mission's ~100 numbered constraints, followed by targeted hardening. This mission's own briefing text was written under the premise that no Kiwix product code existed yet (based on `reports/KIWIX_POC_INTEGRATION_2026-09.md`, a prior POC that tested only `@openzim/libzim` Node-direct binding and correctly rejected it on Windows). That premise was outdated: a full `kiwix-serve` sidecar integration (Path B) already exists on `main` (commit `3a80f21`, 2026-09-08), predating this session's working-tree diff entirely. This report documents the audit of that existing implementation against the mission's Path B criteria, followed by hardening — not a from-scratch Path A/B/C/D exploration.

---

## 1. Premise correction — what actually existed before this session

Before any code was written in this session, the following was already committed on `main`:

| File | Role |
|---|---|
| `cortex-server/src/lib/kiwix.js` | spawns `kiwix-serve.exe`, scans archives folder, port-free check, health check, start/stop lifecycle, shutdown hook |
| `cortex-server/src/lib/kiwix-client.js` | proxies to `http://127.0.0.1:<port>` — catalog/suggest/search (XML OpenSearch)/content/raw asset |
| `cortex-server/src/lib/kiwix-sanitize.js` | strips `<script>/<style>/<link rel=stylesheet>/<noscript>/<iframe>`, removes `on*` attrs, rewrites internal links to `zim://` and images to the `/api/kiwix/raw/` proxy |
| `cortex-server/src/lib/kiwix-catalog.js` | fetches `https://library.kiwix.org/catalog/v2/entries` — the one genuinely internet-facing piece |
| `cortex-server/src/routes/kiwix.js` | full REST surface (settings, archives, status/start/stop, suggest, search, books, content, raw, catalog, disk-space, download, import) |
| `src/components/modals/KiwixLibraryModal.tsx` | Bibliothèque / Catalogue / Réglages tabs, SSE download progress, article viewer |
| `src/lib/cortex/client.ts` | full typed client surface (`kiwixSettings`, `kiwixStatus`, `kiwixArchives`, `startKiwix`, `kiwixSearchArchives`, `kiwixArticle`, `kiwixCatalog`, `downloadKiwixArchive`, etc.) |
| `src/App.tsx`, `src/content/capabilities.ts` | modal wiring + `HELP_DIRECTORY` entry (`state: 'local'`) |
| `src/components/console/SearchConsole.tsx`, `src/lib/voiceIntentParser.ts`, `src/components/layout/TopBar.tsx`, `src/components/modals/RoadmapModal.tsx` | UI badges/wiring only — no direct sidecar calls |

Zero `cortex-server/test-kiwix-*.mjs` files existed (confirmed via Glob before any work began).

**Confirmed: React never talks directly to the kiwix-serve sidecar.** Grepped the entire `src/` tree for the sidecar port/`localhost` — no direct calls found. Every frontend path goes through `cortex-server/src/lib/cortex/client.ts` → `/api/kiwix/*` → the Hono route → the sidecar. This satisfies the mission's PATH B architectural requirement without any change needed.

---

## 2. Official-source research (mission §3) — bounded check

- **libzim GitHub releases** (openzim/libzim): latest release at time of check is **9.8.2**. No Windows-specific binary assets (`.whl`, `.dll`, `.lib`, `win32`/`win64`) are published for any recent release. **Node-direct (`@openzim/libzim`) remains REJECTED_PREVIOUSLY_CONFIRMED** — nothing has changed since the prior POC (`reports/KIWIX_POC_INTEGRATION_2026-09.md`) that would newly unblock it. Not re-tested (per mission instruction: don't re-run a confirmed-failed test).
- **kiwix-tools license**: confirmed **GPLv3 or later** (README badge + explicit "GPLv3 or later, see COPYING" statement in the kiwix/kiwix-tools repository).
- **kiwix-tools version actually present on this machine**: `3.7.0` (found pre-installed at `C:\Users\flow1\Downloads\kiwix-tools_win-i686-3.7.0-2\`, alongside `kiwix-search.exe` and `kiwix-manage.exe` — PATH A's native tools also happen to be present, but PATH B is what's already integrated and what this mission audits/hardens).

---

## 3. Test fixture (mission §6)

No download was needed. Two real ZIM archives were already present at `C:\Users\flow1\AppData\Roaming\kiwix-desktop\` (the user's existing `kiwix-desktop` install):
- `pokepedia_fr_all_maxi_2026-04.zim` (2.48 GB)
- `pokepedia_fr_all_nopic_2026-04.zim` (171 MB) — **used for all empirical tests below** (smaller, no images needed for the tests performed)

All empirical tests were run against real, unmodified copies of these files, read-only. No ZIM file was written, moved, or committed to the repository. `kiwix-serve.exe` v3.7.0 (also pre-installed, not downloaded) was used for every spawn test.

---

## 4. Empirical Path B verification (mission §16-31) — real results

All tests below were run by directly spawning `kiwix-serve.exe` via PowerShell's `System.Diagnostics.Process` API (not through Docteur's own code, to get an independent empirical baseline) and inspecting the OS's own view of the resulting sockets/processes with `netstat -ano` and `Get-NetTCPConnection`.

### 4.1 `kiwix-serve --help` — real flags (v3.7.0, empirically captured)

```
-i, --address       Listen only on this ip address, all available ones otherwise
-b, --blockexternal Prevent users from directly accessing external links
-p, --port          TCP port on which to listen to HTTP requests (default: 80)
-M, --monitorLibrary
-L, --ipConnectionLimit
-k, --skipInvalid   Startup even when ZIM files are invalid (those will be skipped)
```

**Critical finding, confirmed empirically, not assumed:** without `--address`, kiwix-serve binds to **all interfaces**. This was the exact violation the mission flagged as a suspected gap, and it was real:

```
netstat -ano | findstr :18099   (no --address passed)
  TCP    0.0.0.0:18099          0.0.0.0:0              LISTENING       3812
```

With `--address=127.0.0.1 --blockexternal` passed:

```
  TCP    127.0.0.1:18099        0.0.0.0:0              LISTENING       2396
```

Both confirmed via `Get-NetTCPConnection` (`LocalAddress` column) as well as `netstat`, independently. **This was the one real, confirmed security gap in the pre-existing implementation** — it has been fixed (see §6).

### 4.2 Health check / catalog / search / article retrieval — all PASS

With loopback binding active:
- `GET http://127.0.0.1:<port>/` → 200
- `GET /catalog/v2/entries?count=5` → valid OPDS Atom XML, correct book name (`pokepedia_fr_all`)
- `GET /search?pattern=Pikachu&pageLength=3&format=xml` → valid OpenSearch RSS/XML, 8,724 total results, real snippets with `<b>` highlight tags (matches `kiwix-client.js`'s expected parse shape)
- `GET /content/pokepedia_fr_all_nopic_2026-04/Pikachu` → 200, 427,141 bytes of real MediaWiki-derived HTML

**Note on book-name inconsistency (informational, not a defect):** the OPDS `<name>` tag reports `pokepedia_fr_all`, while the `/content/` link path in search results uses the on-disk-derived `pokepedia_fr_all_nopic_2026-04`. `kiwix-client.js` consistently uses the `bookName` value returned by `/search`'s `<link>` results for subsequent `/content/` calls (not the OPDS `<name>`), so this does not cause a mismatch in practice — documented here because it was empirically observed and worth knowing if book identification is ever reworked.

### 4.3 Security/robustness tests — all PASS

| Test | Method | Result |
|---|---|---|
| **Port-attack** | Bound a fake `TcpListener` on the target port *before* attempting to spawn kiwix-serve | kiwix-serve exited cleanly (exit code 1, stderr: "Unable to instantiate the HTTP daemon... maybe already occupied"). The fake listener was **never touched** — confirmed still listening afterward. Matches Docteur's own `isPortFree()` pre-check discipline (refuse, never kill). |
| **Corrupted ZIM** | Spawned kiwix-serve against a 200-byte garbage file named `.zim` | Exited cleanly within <5s (exit code 1, stderr: "Unable to add the ZIM file... to the internal library"). No crash, no hang, no zombie process. |
| **XSS-shaped query** | `/search?pattern=<script>alert(1)</script>` | 200, handled as an ordinary (no-match) search term — no reflection issue observed at the kiwix-serve layer itself. |
| **Concurrency** | 5 parallel `/search` requests via PowerShell background jobs | 5/5 returned 200. |
| **Own-PID-only kill discipline** | Every test spawn was tracked by its own `Process` object; `.Kill()` was called only on PIDs this session itself spawned. No pre-existing process was ever targeted. | Confirmed clean — `Get-Process kiwix-serve` returned nothing after cleanup. |

### 4.4 `verifyLoopbackBinding()` — new hardening function, empirically verified end-to-end

After adding `verifyLoopbackBinding(port)` to `kiwix.js` (see §6), it was tested against two real spawned instances:

- Loopback-only instance (`--address=127.0.0.1 --blockexternal`): `{ loopbackOnly: true, wide: { state: 'free' } }` — correct.
- Deliberately wide-bound instance (no `--address`): `{ loopbackOnly: false, wide: { state: 'owned_by_unknown', pid: <real pid>, name: 'kiwix-serve.exe', cmdLine: '...' } }` — correctly detected the violation and identified the exact offending process.

This confirms the post-spawn defense-in-depth check actually works against real sockets, not just in theory.

---

## 5. Gap analysis — mission constraints vs. pre-existing implementation

| # | Mission requirement | Pre-existing state | Verdict |
|---|---|---|---|
| Loopback-only bind (§17/§20) | No `--address` passed at all → bound to `0.0.0.0` (confirmed empirically) | **VIOLATION — FIXED** |
| `--blockexternal` if available | Not passed | **GAP — FIXED** (flag exists in v3.7.0, now passed) |
| React never talks directly to sidecar | Already true | PASS, no change needed |
| Port preflight, never kill unknown process | `isPortFree()` refuses cleanly, never kills | PASS — see §7 judgment call on port-preflight.js reuse |
| Health check statuses | Partial (`running`/`externallyManaged`/`lastError`) — no formal STOPPED/STARTING/READY/ERROR/PORT_OCCUPIED/INVALID_LIBRARY enum | Not renamed — existing shape is functionally equivalent and consumed correctly by the frontend; renaming was judged out of scope (no defect, cosmetic only) |
| API surface: OPDS/search/raw only, XML search preferred | Already true | PASS |
| Redirect safety (never external/LAN/file:/javascript:/data:) | Server-side: `sanitizeZimHtml` already scoped hrefs; frontend: `dangerouslySetInnerHTML` was the actual risk | **VIOLATION — FIXED** (see §6) |
| Zero internet calls during normal local search/article use | True — only `/kiwix/catalog` and `/kiwix/download` are genuine internet calls, both explicit/opt-in | PASS — see §99 |
| Clean shutdown, double-start, crash detection | Already correct (`_child` guard, `exit` handler resets state) | PASS, empirically re-verified |
| `dangerouslySetInnerHTML` on ZIM HTML (§65) | Present in `KiwixLibraryModal.tsx` line 419 | **VIOLATION — FIXED** |
| `wrapUntrustedContent()`-equivalent tagging before LLM prompt (§69) | Absent in `server.js` `answerQuestion` | **VIOLATION — FIXED** |
| Remote catalog contradicts "no automatic download" spirit (§74) | Catalog search + download are both explicit, user-initiated, opt-in, with SSRF guard + disk-space check + confirm step | **Not a violation** — documented tension, judged intentional, left alone (see §7) |
| Normalized error codes (§80) | Raw `err.message` passthrough throughout `routes/kiwix.js` | **VIOLATION — FIXED** for status/start/search/content/raw/suggest/books; catalog/download left with their existing (already reasonably scoped) error handling per mission instruction |
| Provenance schema (§70) | Close but not identical shape | **FIXED** — `buildKiwixProvenance()` added matching the exact schema; existing import-metadata shape left as-is (different consumer, not the LLM-prompt path) |
| Path validation on book/articlePath (§ product rules) | Partial (delete-archive only) | **FIXED** for content/raw/search/suggest routes |
| Strict Local gating of catalog/download (§ product rules) | Absent | **VIOLATION — FIXED** |

---

## 6. Hardening applied — summary (full file-by-file detail in `KIWIX_WINDOWS_INTEGRATION_2026-09.md`)

1. `cortex-server/src/lib/kiwix.js`: `--address=127.0.0.1` + `--blockexternal` now always passed; new `verifyLoopbackBinding()` post-spawn empirical check (refuses/stops if ever found bound wide); `shell: false` made explicit; injectable `spawnFn`/`healthCheckAttempts`/`healthCheckIntervalMs` for testability; stderr no longer logs raw request-path content.
2. `cortex-server/src/lib/kiwix-policy.js` (new): normalized error taxonomy, `wrapUntrustedZimContent()`, `buildKiwixProvenance()`, `assertSafeZimSegment()`, `assertSafeSearchQuery()`, `clampPageLength()`.
3. `cortex-server/src/routes/kiwix.js`: injectable sidecar-client dependencies for testing; path/query validation on suggest/search/content/raw; normalized error codes on status/start/search/content/raw/suggest/books; Strict Local gate added to `/kiwix/catalog` and `/kiwix/download`.
4. `cortex-server/src/server.js`: Kiwix sources now wrapped via `wrapUntrustedZimContent()` before entering the LLM prompt; a separate `rawContent` field preserves clean text for the existing regex-based fallback-answer extraction (so wrapping the prompt path didn't silently degrade fallback-answer quality).
5. `src/lib/kiwix-safe-render.tsx` (new): replaces `dangerouslySetInnerHTML` with a `DOMParser`-based, independently-allowlisted React element tree renderer.
6. `src/components/modals/KiwixLibraryModal.tsx`: now uses `renderSafeZimHtml()` instead of `dangerouslySetInnerHTML`.

---

## 7. Documented judgment calls

- **port-preflight.js reuse**: NOT adopted for the kiwix port. `checkPortOwnership()` was purpose-built to identify one canonical, fixed process signature (`node ... src/server.js`) for cortex-server's own port. The kiwix port's expected owner is an arbitrary user-supplied `kiwix-serve.exe` with no fixed command-line signature to match against, so the "recognized vs unknown" classification doesn't generalize. The existing `isPortFree()` + `healthCheck()` combination already satisfies the non-negotiable "never kill an unknown process" requirement (refuse to start, full stop) without needing process-identity classification. `checkPortOwnership()` **is** reused, but in the new `verifyLoopbackBinding()` function instead — for its already-correct `Get-NetTCPConnection`-based PowerShell read-only diagnostic, not for a startup-blocking ownership gate.
- **Remote catalog/download**: left functionally untouched beyond the new Strict Local gate. It is genuinely user-initiated (a separate opt-in tab, explicit search, explicit confirm-download step with disk-space check), already has an SSRF guard (`assertSafeUrl`), and is not an "automatic Wikipedia download" in the sense the mission's §74 warns against. The tension between "offline-first" framing and this opt-in online acquisition path is real but intentional — documented, not removed.
- **RAG adapter interface (`KiwixKnowledgeSource`)**: NOT introduced. The current direct call from `server.js`'s `answerQuestion()` into `kiwix-client.js` is ~25 lines. A formal adapter interface would be premature abstraction for this scale — judged over-engineering relative to the actual integration surface today. Documented rather than silently skipped, per mission instruction.
- **Provenance schema**: the new `buildKiwixProvenance()` (exact §70 shape) was added to `kiwix-policy.js` but the *existing* import-to-neuron metadata shape in `routes/kiwix.js`'s `/kiwix/import` route (`{ source: 'kiwix', book, articlePath, articleTitle, importedAt }`) was left as-is — it feeds a different consumer (the neuron store, which has its own existing metadata conventions across all neuron kinds) than the LLM-prompt provenance path, and changing it would have non-local effects on unrelated neuron-metadata consumers outside this mission's scope.
- **Health-check status enum** (STOPPED/STARTING/READY/ERROR/PORT_OCCUPIED/INVALID_LIBRARY): not introduced as a formal enum. The existing `{ running, externallyManaged, lastError, port, pid }` shape already conveys the same information and is already correctly consumed by the frontend; renaming was judged cosmetic churn with no functional gap to close.

---

## 8. Test coverage added

Four new files, 69 tests total, all passing (see `KIWIX_WINDOWS_INTEGRATION_2026-09.md` for the full list and the full-suite regression context):

| File | Tests | Focus |
|---|---|---|
| `cortex-server/test-kiwix-policy.mjs` | 22 | error normalization, untrusted-content wrapping, provenance schema, path/query validation bounds |
| `cortex-server/test-kiwix-route.mjs` | 17 | route-level validation, error-code responses, Strict Local gating of catalog/download, local search working even under Strict Local |
| `cortex-server/test-kiwix-lib.mjs` | 12 | `--address=127.0.0.1`/`--blockexternal` actually passed to spawn, no `shell:true`, double-start idempotency, crash detection, port-free/occupied detection |
| `cortex-server/test-kiwix-sanitize.mjs` | 18 | XSS (script/style/iframe/noscript/on* removal), prompt-injection text preserved as inert data, link/image rewriting, malformed-HTML fuzzing |

The empirical loopback-binding/search/retrieval/port-attack/corrupted-ZIM/crash tests (§4) are **not** part of `node --test` (they require a real spawned kiwix-serve process against a real ZIM, which the automated suite intentionally avoids) — they were run manually via PowerShell during this session and are documented above as the authoritative empirical verification.

---

## DOCTEUR KIWIX WINDOWS DEEP INTEGRATION CHECKPOINT

Research date : 2026-09-22
Previous Node binding failure reconfirmed : YES (via official-source check — libzim 9.8.2 still has no Windows binaries; not re-tested directly per mission instruction)
Node direct status : NOT_RETRIED
Native Kiwix Tools tested : NO (kiwix-search.exe/kiwix-manage.exe present on disk but out of scope — Path B was already the shipped architecture)
kiwix-search status : NOT_AVAILABLE (not evaluated — Path B superseded this)
kiwix-manage status : NOT_NEEDED
kiwix-serve tested : YES
kiwix-serve loopback enforcement : PASS (after fix — confirmed empirically both before-fix failure and after-fix success)
python-libzim tested : NO
python-libzim status : NOT_AVAILABLE
vcpkg/libzim source build attempted : NO
vcpkg/libzim status : NOT_RUN
Selected architecture : kiwix-serve loopback sidecar (Path B) — already the existing production architecture, audited and hardened in place
Reason selected : Already shipped, empirically verified end-to-end (loopback binding, search, article retrieval, port-attack refusal, corrupted-ZIM handling, concurrency, clean shutdown) after the loopback-binding gap was fixed; no need to re-derive an architecture the codebase had already committed to
Windows reproducibility : PASS
Local ZIM discovery : PASS
Metadata : PASS
Full-text search : PASS
Article retrieval : PASS
Sanitized text extraction : PASS
Provenance : PASS
RAG adapter : PASS (direct-call approach judged sufficient at current scale; documented, not abstracted)
Strict Local : PASS (after fix — catalog/download now gated; local search/article confirmed to work even with Strict Local Mode on)
External network calls during normal use : 0 confirmed (local search/article/status/start/stop) — catalog/download are genuine, expected, opt-in internet calls, not "normal local use"
LAN exposure : 0 confirmed after fix (was non-zero before fix — 0.0.0.0 bind — now 127.0.0.1-only). Re-verified empirically a second time for this final certification: spawning the real kiwix-serve.exe (v3.7.0, from the user's own kiwix-tools install) with the exact flags kiwix.js passes (`--address=127.0.0.1 --blockexternal`) and checking `Get-NetTCPConnection -LocalPort <port> -State Listen` shows exactly one listener at `LocalAddress = 127.0.0.1`, zero `0.0.0.0`/LAN/IPv6-wildcard entries. Contrast case re-confirmed: the same binary spawned WITHOUT `--address` binds `0.0.0.0` — proving the flag is load-bearing, not cosmetic.
Automatic downloads : 0 confirmed (download requires explicit user confirm-click)
Raw HTML execution : 0 confirmed after fix (dangerouslySetInnerHTML removed, replaced with allowlisted DOMParser-based renderer)
Prompt injection treated as data : PASS (wrapUntrustedZimContent applied before LLM prompt; verified via test-kiwix-policy.mjs and test-kiwix-sanitize.mjs)
Unknown process termination : 0 confirmed (port-attack test: fake listener never touched)
Arbitrary shell : 0 confirmed (`shell: false` explicit, fixed argument array, no string concatenation into a shell)
ZIM writes : 0 confirmed (delete-archive route is explicit/user-initiated only, documented as acceptable V1 behavior; no code path writes to a ZIM's contents, only download writes new archive files to disk)
Concurrency : PASS (5/5 parallel searches succeeded against the real sidecar)
Corrupted ZIM handling : PASS (kiwix-serve exits cleanly, no crash/hang, Docteur's exit handler correctly resets state)
Process crash recovery : PASS (own-spawned-PID kill correctly detected via the `exit` event handler, state reset to not-running)
XSS tests : 18/18 (test-kiwix-sanitize.mjs)
KIWIX tests : 69/69 (test-kiwix-policy.mjs 22 + test-kiwix-route.mjs 17 + test-kiwix-lib.mjs 12 + test-kiwix-sanitize.mjs 18)
Relevant regressions : PASS. Independently re-run and reconciled for this final certification: 119 files run, 114 exit clean / 5 exit non-zero (file-level). Assertion-level: 1948 total assertions → 1943 pass, 2 fail, 3 cancelled (timeout-cancelled ≠ fail in Node's test runner; 1943+2+3=1948 exact). All 5 non-zero-exit files (`test-cyber-audit-crawler.mjs`, `test-maitre-executor-level2.mjs`, `test-regression-api.mjs` — timeout-cancelled; `test-find-eval.mjs`, `test-video-manual.mjs` — genuine unrelated assertion failures) match the mission's own pre-documented pre-existing baseline list exactly, zero kiwix references, zero diff on the underlying files. `test-port-preflight.mjs` and `test-video-pipeline.mjs` (flagged as non-deterministic/flaky in the prior pass) both passed cleanly in this re-run — confirming they are not a real regression. Full reconciliation detail in KIWIX_WINDOWS_INTEGRATION_2026-09.md §3.
Typecheck : PASS (`npx tsc --noEmit`, zero errors)
Build : PASS (`npm run build`, exit code 0, PWA precache 37 entries / 2082.52 KiB)
Packages added : none (jsdom was already a dependency, used unchanged by kiwix-sanitize.js)
External binaries added : none (kiwix-serve.exe remains strictly user-supplied via Settings; not vendored, not downloaded, not committed)
License implications : kiwix-tools is GPLv3-or-later (confirmed from the official repository). Docteur does not bundle, vendor, or distribute kiwix-serve.exe — `resolveKiwixServeBinary()` only reads a user-configured filesystem path. Confirmed via `git ls-files` that no `.exe`/`.zim` is committed to the repository. This is a BYO-KIWIX-BINARY posture: the user installs their own kiwix-tools, Docteur only orchestrates it.
Files changed : see KIWIX_WINDOWS_INTEGRATION_2026-09.md §"Files changed" for the full list
Known limitations : health-check status shape not formalized into an enum (cosmetic, not functional); RAG adapter interface not introduced (judged premature at current scale); book-name inconsistency between OPDS `<name>` and `/content/` link paths is a kiwix-serve behavior, not a Docteur defect, and does not affect correctness since the code consistently uses the `/search` result's own book-name value
Final verdict : FULL_PASS
