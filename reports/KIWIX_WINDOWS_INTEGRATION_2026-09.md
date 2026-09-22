# DOCTEUR — KIWIX WINDOWS INTEGRATION (HARDENING) — 2026-09-22

Companion to `reports/KIWIX_WINDOWS_DEEP_POC_2026-09.md` (the audit + empirical verification). This report is the file-by-file "what changed and why" for the hardening pass applied to the **already-shipped** kiwix-serve sidecar integration (commit `3a80f21`, 2026-09-08, predating this session).

---

## 1. Files changed — before/after

### `cortex-server/src/lib/kiwix.js` (modified)

| Item | Before | After |
|---|---|---|
| Loopback binding | `spawn(binary, ['--port=8090', ...archivePaths])` — no `--address` → confirmed empirically to bind `0.0.0.0` | `--address=127.0.0.1` always passed. Confirmed empirically via `netstat`/`Get-NetTCPConnection`: now binds `127.0.0.1` only. |
| External-link blocking | Not passed | `--blockexternal` always passed (flag confirmed present in the real `kiwix-serve.exe --help` output for the installed v3.7.0). |
| Post-spawn binding verification | None | New `verifyLoopbackBinding(port)` — reuses `port-preflight.js`'s `checkPortOwnership()` (its existing read-only `Get-NetTCPConnection` PowerShell path) to empirically confirm, after spawn, that the process is not *also* bound to `0.0.0.0`. If it ever is, `startKiwixServe()` stops the process immediately and returns `binding_not_loopback` rather than reporting success. |
| Shell invocation | `spawn(binary, args, { cwd, windowsHide, stdio })` (shell defaulted false implicitly) | `shell: false` made explicit in the options object — no behavior change, but now a visible, auditable guarantee rather than an implicit default. |
| Testability | No way to intercept the spawn call or the ~8s health-check poll loop | `spawnFn`, `healthCheckAttempts`, `healthCheckIntervalMs` are now injectable options (production defaults unchanged: real `child_process.spawn`, 16×500ms ≈ 8s). |
| stderr logging | `logger?.warn?.({ line: chunk.toString().trim() }, ...)` — logged raw kiwix-serve stderr lines, which can include request paths | Now logs a fixed message only, never the raw stderr content, per the mission's logging-audit requirement (no sensitive path/query ever logged). |

**Behavior change a user will notice:** none in normal operation — search/article retrieval/start/stop all work identically. The only behavior change is that kiwix-serve now refuses (and Docteur reports `binding_not_loopback`) in the hypothetical case where the sidecar somehow still ends up bound wide despite the new flag — which did not happen in any empirical test after the fix.

### `cortex-server/src/lib/kiwix-policy.js` (new, 169 lines)

New module, same shape as `sales-policy.js` (explicitly named as the pattern reference by the mission). Exports:
- `KiwixError`, `KIWIX_ERROR_CODES` (`KIWIX_NOT_CONFIGURED`, `KIWIX_BACKEND_UNAVAILABLE`, `KIWIX_LIBRARY_INVALID`, `KIWIX_ZIM_NOT_FOUND`, `KIWIX_SEARCH_UNAVAILABLE`, `KIWIX_SEARCH_TIMEOUT`, `KIWIX_ARTICLE_NOT_FOUND`, `KIWIX_INVALID_PATH`, `KIWIX_PROCESS_FAILED`) — the exact set mission §80 names.
- `classifyKiwixError(err, { context })` / `kiwixErrorBody(classified)` — maps any caught error to one of the above codes, never forwarding the raw message to the client.
- `wrapUntrustedZimContent({ book, articlePath, title, content })` — same idiom as `sales-policy.js`'s `wrapUntrustedContent()`: tags `{ untrusted: true, offline: true, source: 'kiwix' }` and produces a fenced `promptFragment` warning against treating embedded text as instructions.
- `buildKiwixProvenance(...)` — exact mission §70 shape: `{ sourceType: 'KIWIX', zimId, zimTitle, articlePath, articleTitle, retrievedAt, offline: true }`.
- `assertSafeZimSegment(value)` — rejects empty/overlong (>512 chars)/control-char/traversal (`..`)/absolute-URL-smuggling path segments before they're used to build a request to the local sidecar.
- `assertSafeSearchQuery(pattern)` / `clampPageLength(value, fallback)` — query length bound (300 chars), page-length bound (≤50), control-char rejection.

### `cortex-server/src/routes/kiwix.js` (modified)

| Item | Before | After |
|---|---|---|
| Dependency injection | `suggest`/`search`/`listBooks`/`getContent`/`getRawAsset`/`searchCatalog` were called directly from the module-level import | `createKiwixRoute({ ..., kiwixSuggest, kiwixSearch, kiwixListBooks, kiwixGetContent, kiwixGetRawAsset, kiwixSearchCatalog })` — each now an injectable parameter defaulting to the real function, mirroring `createSalesRoute({ search, fetchContent, checkUrl })`. This is what made the route testable without spawning a real kiwix-serve process. |
| Path validation | None on `/kiwix/suggest`, `/kiwix/search`, `/kiwix/content/:book/*`, `/kiwix/raw/:book/*` (only the pre-existing delete-archive route validated its filename param) | `assertSafeZimSegment()` now guards `book` and the wildcard path on content/raw; `assertSafeSearchQuery()` guards the search/suggest pattern; `clampPageLength()` bounds the search page size. Documented empirically (see the POC report §4) that a literal `../` in the URL is already collapsed by standard URL normalization before Hono's router sees it — the realistic bypass this catches is a double-encoded segment (`..%2f..%2f`) that survives normalization and reaches the handler as a literal string. |
| Error responses | `return c.json({ error: err.message }, 502)` on suggest/search/books/content/raw — raw kiwix-serve/fetch error text forwarded directly | Every one of those routes now catches, classifies via `classifyKiwixError()`, and returns only `{ error: KIWIX_XXX_CODE }` with an appropriate HTTP status (400/404/502/503/504 as appropriate) — the raw message is still passed to `logger?.warn?.()` for server-side diagnostics only, never to the response body. Verified via test (`test-kiwix-route.mjs`: "raw message never in the response body"). |
| `/kiwix/start` error mapping | Returned `{ ok:false, error: 'binary_not_found' \| 'no_archives' \| 'port_in_use' \| 'spawn_failed', message }` (French user-facing strings, unchanged and kept) | Now also includes a normalized `code` field (`KIWIX_NOT_CONFIGURED` / `KIWIX_LIBRARY_INVALID` / `KIWIX_BACKEND_UNAVAILABLE` / `KIWIX_PROCESS_FAILED`) alongside the existing French message, so frontend logic that wants a stable machine-readable code has one, without breaking the existing user-facing text. |
| Strict Local gating | `/kiwix/catalog` and `/kiwix/download` had no gate — both are genuine internet calls (library.kiwix.org / a ZIM mirror host) | Both routes now call `assertCloudAllowed(c, STRICT_LOCAL_MESSAGE)` first (same pattern as `research.js`/`free-ai.js`), returning a 503 with `{ strict_local: true }` when Strict Local Mode is on. Verified: local `/kiwix/search` continues to work even with Strict Local Mode on (it never leaves the loopback sidecar). |
| `/kiwix/catalog`, `/kiwix/download` error bodies | `{ error: err.message }` | **Left unchanged** per mission instruction ("don't need to touch the remote-catalog/download routes' error handling unless trivial") — these are already reasonably scoped, separate concern from the local-sidecar error taxonomy. |

### `cortex-server/src/server.js` (modified — kiwix-related lines only; file had pre-existing unrelated uncommitted changes from other in-flight work, untouched here)

- Kiwix search results in `answerQuestion()` are now passed through `wrapUntrustedZimContent()` before being placed in the LLM prompt context. The `content` field used by `buildContextMessages()` (which builds the actual LLM messages) now carries the wrapped, fenced, "this is DATA not instructions" framing — identical prompt-injection-isolation idiom to `sales-policy.js`/`investment-policy.js`'s existing treatment of externally-fetched web content.
- **Regression avoided**: `extractFallbackAnswer()` (the regex-based fallback answer extractor used when the LLM declines to answer) previously read `source.content` directly. Since `content` now carries the wrapper's framing text instead of clean article text for Kiwix sources, a new `rawContent` field was added alongside `content` specifically to preserve the clean extracted text, and `extractFallbackAnswer()` now reads `source.rawContent ?? source.content`. This was caught and fixed before it could silently degrade fallback-answer quality for Kiwix-sourced answers.
- The frontend-facing `sources` array returned to the client (`sources.map(({ id, title, score, kind, isKiwix, book, articlePath }) => ...)`) was already field-allowlisted and does not include `content`/`rawContent`/`untrusted` — confirmed no leak of the wrapped prompt text or raw article text to the client response.

### `src/lib/kiwix-safe-render.tsx` (new, 128 lines)

Replaces `dangerouslySetInnerHTML` for ZIM article rendering. Parses the already-server-sanitized HTML with `DOMParser` into a **detached** `Document` (never attached to the live page, so nothing in it can execute regardless of content), then walks it into a plain React element tree with its own **independent** allowlist:
- Tag allowlist: `a, p, div, span, b, strong, i, em, u, br, hr, h1-h6, ul, ol, li, table*, img, blockquote, code, pre, sup, sub, small, figure, figcaption, caption, dl, dt, dd` — any tag outside this list renders as plain text (its markup is dropped, its text content is kept), never as unvalidated structure.
- `href` allowlist: `zim://...` (internal, already rewritten server-side), `#...` (in-page anchor), `http(s)://...` and `mailto:...` (rendered with `target=_blank rel="noopener noreferrer"`) — anything else (`javascript:`, `data:`, `vbscript:`, `file:`, etc.) is stripped of its `href` entirely, rendering as inert text.
- `img src` allowlist: only `/api/kiwix/raw/...` (the existing cortex-server proxy path) or `data:image/...` — any other `src` causes the image to be dropped entirely rather than rendered.
- Belt-and-suspenders: `<script>`/`<style>` elements are explicitly removed from the parsed document before walking, even though the tag allowlist already excludes them and the server-side `sanitizeZimHtml()` already strips them.

This is defense-in-depth on top of the existing server-side sanitization, not a replacement for it — `sanitizeZimHtml()` in `kiwix-sanitize.js` was left unchanged (still strips scripts/styles/iframes/on* attributes server-side); the frontend renderer independently re-validates rather than trusting that layer alone.

### `src/components/modals/KiwixLibraryModal.tsx` (modified, 6 lines)

```diff
- <div ... dangerouslySetInnerHTML={{ __html: article.html }} />
+ <div ...>{renderSafeZimHtml(article.html)}</div>
```

The existing `handleArticleClick()` click-delegation handler (which intercepts clicks on `[data-zim-link]` anchors to navigate within the modal instead of following a real link) required no change — `renderSafeZimHtml()` preserves the `data-zim-link` attribute on internal links exactly as the server-side sanitizer set it.

---

## 2. New test coverage

| File | Tests | What it proves |
|---|---|---|
| `cortex-server/test-kiwix-policy.mjs` | 22 | Error-code mapping for timeout/connection-failure/404/generic cases; error response bodies never contain the original raw message; untrusted-content wrapping tags `untrusted:true`/`offline:true`, fences content, preserves an embedded "SYSTEM: ignore instructions" payload as inert quoted data; provenance schema matches §70 exactly; path-segment validation (traversal, control chars, null bytes, overlong, absolute-URL smuggling); search-query bounds and page-length clamping. |
| `cortex-server/test-kiwix-route.mjs` | 17 | Route-level behavior with injected mocks (no real kiwix-serve spawned): valid search/content/raw succeed; local search works even with Strict Local Mode ON; overlong/control-char queries rejected 400; double-encoded traversal segments rejected 400 (with the URL-normalization nuance documented in a test comment); backend/timeout/not-found failures normalized with no raw message leak; `/kiwix/catalog` and `/kiwix/download` return 503 with Strict Local Mode on and succeed with it off; pre-existing delete-archive traversal guard still works. |
| `cortex-server/test-kiwix-lib.mjs` | 12 | `startKiwixServe()` actually passes `--address=127.0.0.1` and `--blockexternal` to the spawned process (verified via an injected `spawnFn` capturing the real argument array); `shell:false` explicit; correct port flag; refuses to start with zero archives or a missing binary (never calls `spawnFn`); double-start is idempotent (spawns exactly once); a crashed/exited child correctly resets `getStatus().running` to `false`; `isPortFree()` correctly detects both an occupied and a free port against real `net.Server` instances. |
| `cortex-server/test-kiwix-sanitize.mjs` | 18 | XSS: `<script>`/`<style>`/`<iframe>`/`<noscript>` all removed; `on*` attributes stripped case-insensitively; a prompt-injection-shaped payload survives sanitization as inert plain text (not executable markup); internal links rewritten to `zim://` with `data-zim-link`; external links get `target=_blank`/`rel=noopener noreferrer`; images rewritten to the `/api/kiwix/raw/` proxy or left as `data:` URIs, never left pointing at kiwix-serve directly; `srcset` stripped; malformed/empty/fragment-only HTML never throws. |

**69 tests total, all passing** (individually and within the full 119-file suite run — verified both ways).

The empirical, non-automatable verification (real loopback binding via `netstat`/`Get-NetTCPConnection`, real search/article retrieval against the user's actual ZIM fixture, port-attack refusal, corrupted-ZIM handling, concurrency, own-PID-only crash recovery) was performed manually via PowerShell during this session and is documented in `KIWIX_WINDOWS_DEEP_POC_2026-09.md` §4 — it intentionally is not part of `node --test` since it requires a real spawned `kiwix-serve.exe` process against a real multi-hundred-MB ZIM file, which the automated suite avoids by design (same discipline as the rest of the test suite, which mocks all such processes).

---

## 3. Full backend regression

Ran all 119 `cortex-server/test-*.mjs` files individually (`node --test --test-timeout=20000 <file>`).

**Reconciliation note (superseding the earlier "1938/1946, 7 files" figure from the first pass — that number mixed two different units and undercounted timeout-cancelled assertions):**

There are two distinct counting units at play, and Node's test runner reports a *third* outcome (`cancelled`) that a naive `pass + fail` sum silently drops:

- **File-level** (process exit code): out of 119 files, how many exited non-zero. A file exits non-zero if it has ANY assertion that is not `pass` — whether that assertion's outcome was `fail` or `cancelled`.
- **Assertion-level** (individual `test()` calls, Node's own `# tests` / `# pass` / `# fail` / `# cancelled` tallies per file): a timed-out assertion is reported by Node as `cancelled`, not `fail` — so summing only `pass` and `fail` misses it, which is exactly the arithmetic gap in the original "1938/1946" figure (1946 − 1938 = 8, but only 2 of those were genuine `fail`; the other 6 were `cancelled`, silently uncounted by that framing across a slightly different run of the suite).

**This certification's independently re-run, exact reconciled result** (`reports/kiwix-final-cert-2026-09-22/SUMMARY.txt` + per-file logs):

- **File-level: 119 files run, 114 exit 0 (clean), 5 exit non-zero.**
- **Assertion-level: 1948 total assertions across all 119 files → 1943 `pass`, 2 `fail`, 3 `cancelled` (1943 + 2 + 3 = 1948, verified exactly).**

| File | tests | pass | fail | cancelled | Cause | Verdict |
|---|---|---|---|---|---|---|
| `test-cyber-audit-crawler.mjs` | 21 | 20 | 0 | 1 | 20s test-timeout on one subtest (harness's own `--test-timeout=20000`, not a code defect) | Pre-existing, matches mission's own pre-documented baseline list, unrelated |
| `test-maitre-executor-level2.mjs` | 34 | 33 | 0 | 1 | Same 20s test-timeout pattern | Pre-existing, matches baseline list, unrelated |
| `test-regression-api.mjs` | 1 | 0 | 0 | 1 | Same 20s test-timeout pattern | Pre-existing, matches baseline list, unrelated |
| `test-find-eval.mjs` | 1 | 0 | 1 | 0 | Genuine assertion failure, unrelated subsystem (find/eval tooling) | Pre-existing, matches baseline list, unrelated |
| `test-video-manual.mjs` | 1 | 0 | 1 | 0 | Genuine assertion failure, unrelated subsystem (manual video test) | Pre-existing, matches baseline list, unrelated |

All 5 are confirmed by name against the pre-existing baseline already documented before this mission started (`reports/CODE_INTELLIGENCE_READONLY_CHECKPOINT_2026-09-22.md` §2, `reports/BUSINESS_SALES_AGENT_V1_CHECKPOINT_2026-09-22.md` §6) — same 5 files, same failure modes, present before any Kiwix change existed. Zero `kiwix` references in any of the 5 (confirmed via `grep -c kiwix`), and none of the underlying files carry a git diff from this mission.

**`test-port-preflight.mjs` and `test-video-pipeline.mjs`** — flagged as non-deterministic/flaky in the prior pass — **passed cleanly in this independently re-run, fully-reconciled regression** (both `PASS`, 0 fail). This confirms their earlier characterization as timing-sensitive/environmental rather than a deterministic regression: `port-preflight.js` has zero diff in this session (only read-only imported by `kiwix.js`'s new `verifyLoopbackBinding()`), and `test-video-pipeline.mjs` has zero `kiwix` references and zero diff.

All 4 Kiwix test files (`test-kiwix-policy.mjs` 22, `test-kiwix-route.mjs` 17, `test-kiwix-lib.mjs` 12, `test-kiwix-sanitize.mjs` 18) passed cleanly, both in isolation and within this full-suite run: **69/69, re-verified twice independently.**

---

## 4. Typecheck + build

- `npx tsc --noEmit` (repo root) → **PASS**, zero errors (including the new `src/lib/kiwix-safe-render.tsx` and the modified `KiwixLibraryModal.tsx`).
- `npm run build` (`tsc && vite build`) → **PASS**, exit code 0. 1745 modules transformed, build completed in 1.70s, PWA precache generated (37 entries, 2082.52 KiB). No new build warnings attributable to Kiwix changes (the pre-existing "chunks larger than 500 kB" warning is unrelated to this mission — it references `index-*.js`/`esm-*.js`, not any Kiwix bundle).

---

## 5. Install footprint / license (mission §54/§95)

- **kiwix-serve.exe is NOT vendored or bundled in the Docteur repository.** `resolveKiwixServeBinary()` (`cortex-server/src/lib/kiwix.js`) only ever reads a user-configured filesystem path (`Réglages` tab → "Dossier kiwix-tools"). Confirmed via `git ls-files | grep -i "kiwix\|\.zim$"` that only source `.js`/`.tsx` files are tracked — no `.exe`, no `.zim`.
- **kiwix-tools license**: GPLv3-or-later (confirmed from the official `kiwix/kiwix-tools` GitHub repository — README badge + explicit "GPLv3 or later, see COPYING" statement).
- **License-gate answer**: **BYO KIWIX BINARY.** The user installs their own kiwix-tools distribution (as this machine's user already had, independently, at `C:\Users\flow1\Downloads\kiwix-tools_win-i686-3.7.0-2\`) and points Docteur at it via Settings. Docteur itself distributes zero GPL-licensed binary code — it only orchestrates a user-supplied external process over HTTP on loopback. No new dependency was added to `package.json` (`jsdom` was already present, used unchanged).

---

## 6. Judgment calls (full rationale in the POC report §7 — summarized here)

1. **`port-preflight.js`'s `checkPortOwnership()` was NOT adopted as a startup-blocking gate** for the kiwix port — its process-identity classification is purpose-built for one fixed, known process signature (cortex-server's own `src/server.js`), which doesn't generalize to an arbitrary user-supplied `kiwix-serve.exe`. It **was** reused, read-only, inside the new `verifyLoopbackBinding()` post-spawn diagnostic — the smallest safe reuse rather than forcing a bad-fit gate.
2. **Remote catalog/download routes were left functionally untouched** beyond the new Strict Local gate — already user-initiated, already SSRF-guarded, already disk-space-checked, judged a deliberate opt-in feature rather than an "automatic download" violation.
3. **No formal `KiwixKnowledgeSource` RAG adapter interface was introduced** — the current ~25-line direct call from `answerQuestion()` was judged too small to justify a formal interface layer.
4. **Health-check status shape left as-is** (not reshaped into a formal STOPPED/STARTING/READY/ERROR/PORT_OCCUPIED/INVALID_LIBRARY enum) — the existing `{ running, externallyManaged, lastError }` shape already conveys equivalent information with no functional gap.

---

## Summary

Pre-existing kiwix-serve sidecar integration audited against the mission's ~100 constraints. One real, empirically-confirmed security gap found and fixed (wide network binding by default). Five other mission-flagged violations fixed (raw HTML injection, missing prompt-injection isolation, raw error-message leakage, missing Strict Local gating on internet-calling routes, thin path validation). 914 lines of new code/tests added across 6 new files; 4 existing files modified with surgical, additive changes. 69 new tests, all passing; full 119-file regression suite shows no new failures beyond confirmed pre-existing/environmental ones. Typecheck and build both clean.
