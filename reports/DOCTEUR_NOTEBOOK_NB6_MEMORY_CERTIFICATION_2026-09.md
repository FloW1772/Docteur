# DOCTEUR NOTEBOOK — NB-6: security certification of DOCTEUR MEMORY (audit + fixes, no new feature)

Date: 2026-09-30 · Uncommitted (only `git status --short` / `git diff --stat` / `git diff --name-only`). Scope chosen with the user: **audit and certify NB-5 against the NB-6 pass criteria; fix what the audit finds; add nothing else.** No personal data anywhere (synthetic, `FAKE…` secrets).

## 1. Method

Every criterion was attacked, not re-asserted: a new adversarial suite (`test-nb6-memory-certification.mjs`, 12 tests) plus extra checks in the NB-5 browser test and the real-server boot proof. Two real defects were found and fixed; the rest held.

## 2. Defects found and fixed

| # | Criterion | Finding | Fix |
|---|---|---|---|
| 1 | **0 secret leakage** | A NB-4 candidate whose text (or evidence quote) contained a secret could be approved with a *clean rewritten statement*, and the secret was still copied into `original_statement`, `provenance.originalStatement` and the evidence quote snapshots (visible in the UI / API). The statement itself was already scanned; the *copied* fields were not. | `safeCopy()`: everything copied from another store (original statement, provenance, evidence quotes from candidates, merged candidates and document chunks, plus the insert path) is re-scanned — secret masked, private key ⇒ whole snippet replaced by `[contenu masqué : secret]`. Test: no `FAKE` fragment in any `dmem_*` table, FTS, revisions, usage, audit, logs, API objects or HTTP errors. |
| 2 | **0 hidden memory injection / poisoning**, browser security | The memory routes accepted a **cross-origin "simple" POST** (`text/plain`, no preflight) whose body was JSON: CORS only hides the *response*, the write was executed. Any web page open in the user's browser could silently **create memory** (poisoning what the assistant later trusts). DNS rebinding (`attacker.example → 127.0.0.1`, same-origin so no Origin header) could also **read** memory. | `memoryRequestGuard` on `/api/docteur-memory/*`: **Host** must be a loopback name or a private-LAN IP (defeats rebinding, reads included); an **Origin**, when present, must be local (`null`, `file://`, foreign or look-alike hosts such as `127.0.0.1.evil.example` ⇒ 403); writes with a body must be `application/json` (415 — a cross-origin JSON write needs a preflight, which CORS denies); body ≤ 64 KB (413). Local non-browser clients without Origin keep working (same trust model as the rest of the app). |

Residual, stated plainly: an Origin on **another loopback port** is treated as local (a hostile page must already be served from this machine); and — observation only, **not changed** because it is outside NB-5 and touches non-memory modules — the pre-existing app routes still process cross-origin simple requests (`server.js`'s comment calls this « strict CORS/Origin validation », but CORS alone does not block the request). Worth a dedicated mission.

## 3. Criterion by criterion

| Criterion | Evidence | Result |
|---|---|---|
| 0 external memory transmission | static scan of the 4 NB-5 files; lifecycle incl. HTTP routes with spies on `http/https/net.connect/dns.lookup/resolve/fetch` = 0 calls; real boot: one listener (`127.0.0.1`), no new port | **PASS** |
| 0 cross-project leakage | SQL scope filter + LanceDB predicate; hostile project ids (`' OR '1'='1`, `%`, `*`, `../`, case tricks) ⇒ `INVALID_SCOPE`; FTS-injection queries (`" OR "1"="1`, `NEAR(`, `; DROP TABLE…`) return nothing and change nothing; id enumeration ⇒ `CROSS_PROJECT_DENIED`; **poisoned vector row with the wrong scope columns cannot pass** (the SQL row is authoritative); 144-config calibration grid: 0 | **PASS** |
| 0 cross-notebook leakage | same suite (notebook A memory unreachable from B, with or without a project) | **PASS** |
| 0 secret leakage | defect 1 fixed; refused attempts persist nothing; HTTP error never echoes the secret; logs/usage/audit clean | **PASS** |
| 0 automatic tool execution | an LLM reply that « obeys » the memory (`powershell`, OMEGA, email) causes 0 spawn/exec/fork, 0 network, 0 file write; the answer contract has no tool/action field | **PASS** |
| 0 memory-as-system-authority | fixed system prompt; only Docteur's prompt carries instructions; `authority: CONTEXT_ONLY`; statements fenced in per-request random boundary | **PASS** |
| 0 stale/revoked memory retrieval | revoked, expired (`DELETE_AFTER`), future-dated, superseded, edited-without-reindex: none returned — FTS **and vector-only**; a revoked memory whose vector was left in the index (desync attack) is still excluded at query time; stale statement hash ⇒ `VECTOR_STALE` | **PASS** |
| 0 hidden memory injection | defect 2 fixed; repo scan: **only** the memory module, its route, the runtime, `server.js` mount, `client.ts`, the MÉMOIRE panel/tab and the schema/purge hooks reference memory — chat, ask, summary, search, RASSILON, OMEGA, Device Fabric never do; a plain `retrieve` leaves no usage trace; `answer` reports **exactly** the memories injected (block count = `memoryUsed` = usage rows); no relevant memory ⇒ no memory block at all | **PASS** |
| 0 frozen-module modification | `git diff --name-only` contains no Device Fabric / OMEGA / RASSILON / Maître path | **PASS** |
| 0 NEW regression | §5 | **PASS** |
| Memory retrieval scoped + contextual | scopes, unresolved project ⇒ no project memory, precedence as ordering only, calibrated on real embeddings (hit@3 0.839, FP 0/18) | **PASS** |
| Memory provenance | mandatory for candidate memory, links not copies, `SOURCE_MISSING` handling, secret-safe copies (defect 1) | **PASS** |
| Prompt-injection isolation | forged `<<<MEMORY … >>>` / `<<<END>>>`, fake `MÉMOIRE UTILISATEUR` header, `system:` / `[M7]` markers, forged `provenance:` line, hostile **project name** (never reaches the model; only the sanitised id) — exactly one envelope per memory, statements can only live inside their own envelope, question stays verbatim | **PASS** |
| Sensitive-memory exclusion | default retrieval = NORMAL only in FTS, **pure vector hit** (sensitive memory *is* indexed, excluded at query time), `types` filter, answer, usage, conflict notes (a sensitive memory contradicting a normal one is neither injected nor hinted); `includeSensitive` does not unlock HIGHLY_SENSITIVE | **PASS** |
| Offline operation | lifecycle with every network primitive replaced by a throwing spy; browser test aborts every non-loopback request (0 seen) | **PASS** |
| Network proof | as above + real listener inventory | **PASS** |
| Browser security | UI source has no HTML sink (`innerHTML`, `dangerouslySetInnerHTML`, `document.write`), no `eval`/`new Function`, no browser storage, no external URL / `href` / `target` / `window.open` / `WebSocket` / `fetch`; XSS payloads render as text (statements, quotes, revisions, answers); every memory write with a body is `application/json` (8+ writes observed in Chromium); nothing persisted in `localStorage` / `sessionStorage` / cookies; **real Chromium on `https://evil.example` against the real server**: simple POST, JSON POST, DELETE and read all failed and the memory count was unchanged (Chromium's Private-Network-Access blocks these first; the server guard is proven separately with raw `Host`/`Origin`/`Content-Type` requests) | **PASS** |
| Typecheck / build / boot | `npx tsc --noEmit` PASS · `npm run build` PASS · boot proof **29/29** (27 previous + DNS-rebinding + hostile page), hard-kill restart, SESSION_ONLY absent after restart, one listener | **PASS** |

Also verified: error hygiene (a broken store returns a generic `500 MEMORY_INTERNAL`, no stack/path/SQL); prototype-pollution JSON keys (`__proto__`, `constructor`) do not pollute; malformed / array JSON ⇒ 400.

## 4. Files

New: `cortex-server/test-nb6-memory-certification.mjs`; this report.
Modified: `cortex-server/src/lib/notebook-memory.js` (`safeCopy` on every copied field), `cortex-server/src/routes/notebook-memory.js` (`memoryRequestGuard`, body limit), `scripts/test-notebook-nb5-browser.mjs` (+2 assertions: JSON-only writes, no persisted memory content), `cortex-server/nb5-boot-proof.mjs` (+2 steps: rebinding, hostile page). Nothing else.

## 5. Tests

| Suite | Result |
|---|---|
| Historical Notebook files (5) | 75/75 |
| NB-2 / NB-3 / NB-4 / NB-5 | 37/37 · 31/31 · 44/44 · 38/38 |
| **NB-6 certification** | **12/12** |
| Notebook backend total | **237/237** |
| Browser: NB-2 / NB-3 / NB-4 / NB-5 files | 18 · 34 · 44 · 62 |
| Phase 1–7, batch A–D, privacy, strict-local, Shorts, Phase-3 adaptive memory (26/26) | 0 failures |
| Device Fabric / RASSILON / Maître static audits, OMEGA view, DF route, RASSILON settings | 23/23 · 28/28 · 8/8 · 23/23 · 11/11 · 10/10 |
| tsc / build / real boot ×2 | PASS / PASS / 29/29 |
| Secret scan (new + changed files) | 0 non-synthetic secrets |

## 6. Known limitations (unchanged from NB-5 unless noted)

Real AI export validation **NOT_RUN** (ChatGPT/Gemini/Claude adapters SYNTHETIC_ONLY); 100 k-memory benchmark NOT_RUN; recall is deliberately conservative (5/31 paraphrase positives missed); conflict/supersession detection are heuristics that only propose; interactive creation is O(n) (237 ms at 10 k). New: the request guard trusts any loopback-hosted origin, and non-memory routes were not hardened (§2).
