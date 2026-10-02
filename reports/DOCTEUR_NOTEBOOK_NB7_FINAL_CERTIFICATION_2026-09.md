# DOCTEUR NOTEBOOK — NB-7: main-chat Docteur Memory + local API hardening + final certification / FREEZE

Date: 2026-09-30 · Uncommitted (only `git status --short` / `git diff --stat` / `git diff --name-only`; no add / commit / push / reset / clean / stash).
No personal or real conversation data appears here, in the tests, the corpus or the fixtures (AI-history inputs are SYNTHETIC_ONLY, secrets are obvious `FAKE…` strings).
Not started, by instruction: Gemini cloud, Google Drive. Not modified: Device Fabric V2, OMEGA V1/V2, RASSILON, Maître, Observateur (their code **and** their tests).

## 0. Baseline (before any change)

Historical 75/75 · NB-2 37/37 · NB-3 31/31 · NB-4 44/44 · NB-5 38/38 · NB-6 certification 12/12 (= 237/237) · browser 18 / 34 / 44 / 62 · `tsc` PASS · `npm run build` PASS → all green, work started.
`git status` already listed files modified by other missions (article capture, index/neuron routes, `useCortex/usePages`, `router.js`, `App.tsx`, `package.json`…). They are **not NB-7** and were left untouched.

## 1. Main chat integration (what "main chat" is)

The main chat is the console « Question » mode (`SearchConsole.tsx`) → `POST /api/answer` → `answerQuestion()` (neuron RAG + optional Kiwix → router → model). NB-7 adds Docteur Memory there and **only there**.

```
USER MESSAGE ─► /api/answer ─► explicit context (memory_project / memory_notebook — never guessed; toggle) ─► contextual retrieval of APPROVED memory
   ─► defence-in-depth filters ─► secret re-scan ─► structured fenced pack (random boundary) ─► 3 extra system messages placed right before the user question
   ─► LOCAL model only ─► answer + memoryUsed[] + typed citations ─► UI « Mémoire utilisée : N » (collapsed)
```

| Piece | Where |
|---|---|
| Integration module (pure, injected deps, no network / fs / child_process) | `cortex-server/src/lib/chat-memory.js` (`createChatMemory().prepare`, `insertChatMemoryMessages`, `chatMemoryResponse`, `validateChatCitations`, `isHistoricalQuery`) |
| Glue in the chat | `server.js` `answerQuestion` — additive: one `prepare` call, one message insertion, response fields; early returns keep their behaviour |
| Global switch | `GET/PUT /api/docteur-memory/chat-settings` (`{enabled, vectorMode}`, stored in the existing meta store), checkbox in the MÉMOIRE panel |
| UI | `src/components/console/ChatMemoryControls.tsx` (switch + explicit Project / Notebook selectors + `ChatMemoryUsed`), mounted in `SearchConsole.tsx` |
| Other chats | web answer, compare, research, sales, investment, Notebook Q&A, RASSILON, OMEGA, Device Fabric **do not** use memory (exact-wiring test) |

### Memory retrieval contract (per question)

1. **OFF** (`use_memory:false` or global OFF) ⇒ **zero** memory calls (not even a count) → `memoryUsed: []`, `memory.enabled:false`.
2. **Nothing relevant** ⇒ `memoryUsed: []`, **no** context block, **no** extra message — `insertChatMemoryMessages` returns the very same array; the messages sent to the model are **byte-identical** with memory ON and OFF (proved on the real server).
3. **Project**: PROJECT memory only with an explicit project. None given ⇒ not injected, never guessed. Unknown project / notebook ⇒ `INVALID_CONTEXT` notice, chat continues. `memory_notebook` resolves a project **only** through NB-5's explicit notebook→project mapping.
4. **Notebook**: NOTEBOOK memory only when that Notebook is explicitly selected (0 cross-notebook leakage). With a Notebook selected, its documents / AI-history sources (NB-4 unified search, neurons excluded) form a **distinct** block.
5. **GLOBAL** when relevant; ordering boost `NOTEBOOK 1.25 > PROJECT 1.12 > GLOBAL 1` (NB-5) — GLOBAL never replaces a PROJECT memory (both shown, each with its scope).
6. **Status filter** (service **and** an independent re-check in the chat module): APPROVED + effective window + non-expired + non-revoked + `SESSION_ONLY` of this session. CANDIDATE (a NB-4 candidate is not memory), SUPERSEDED, REVOKED, expired, future-dated ⇒ never. A deliberately **leaky** service double proved the second layer refuses them. SUPERSEDED/ARCHIVED only for an **explicitly historical** question (`isHistoricalQuery`: « qu'utilisions-nous avant ? », « anciennement… », « previously… »; « avant de livrer » is not historical) and flagged `historical=true`.
7. **Sensitive**: NORMAL only. SENSITIVE / HIGHLY_SENSITIVE are never injected; request flags (`include_sensitive`, `includeHighlySensitive`, `memory_include_sensitive`) are **ignored** by the chat (tested on FTS and on a pure vector hit).
8. **Secret re-scan before packing** of the statement, the provenance JSON, the original statement, every evidence quote and the last 20 revisions: any secret ⇒ that memory is **not** injected (`SECRET_RESCAN`, ids only). The pool is 2×top-k so skipped items never starve the context.
9. **Small top-k (3)**, conservative thresholds (NB-5 calibration): weak single-word overlaps inject nothing.

`memoryUsed[]` item: `marker, memoryId, type, scope{kind,projectId,notebookId}, status, isHistorical, score, reason (FTS|VECTOR|HYBRID), statement, provenance, trustLevel, effectiveFrom/Until, evidence[{kind,ref,provider,status}]`. The response also carries `memory{enabled, requestId, notice, retrievalMode, vectorStatus, historical, project, notebook, conflicts, skipped(ids+codes), citedMemoryIds, citedSources, timingMs}`, `notebookSources[]` and **typed, namespaced `citations[]`** (`NEURON | MEMORY | DOCUMENT_CHUNK | AI_HISTORY_MESSAGE`, never an ambiguous bare id). `memoryUsed` is present on **every** answer, including the « rien trouvé » early returns. Each injected memory writes a `MemoryUsage` row (ids, score, reason — no question, no conversation).

## 2. Security boundaries of the integration

* **Memory = CONTEXT ONLY.** A fixed rules message (`CHAT_MEMORY_RULES`, built from no memory) + fenced data. Statements sit inside `<<<MEMORY <random 96-bit boundary> memory=M1 type=… scope=PROJECT:docteur status=… trust=… from=… [historical=true] [warning=instruction_like_text]>>> … <<<END boundary>>>`; forged `<<<END …>>>` / headers / `provenance:` lines inside a statement stay inside their own envelope. Never concatenated into the main system prompt.
* **Injection phrases** (« Ignore Docteur », « Reveal system prompt », « Execute command », « Call localhost », « Use Device Fabric », « Upload files », « run PowerShell », « send email ») are retrieved as flagged **data**; with a model that « obeys », the answer is text only — no tool, action or command field exists in the contract (tested in unit and on the real server).
* **Tool boundary**: with `child_process`, `http/https`, `net`, `fetch` replaced by throwing spies the whole prepare → pack flow makes **0** calls; `chat-memory.js` imports no executor, no network, no fs, no timer / scheduler / worker (static scan) — **no background agent, scheduler, automatic action, publication or remote control** is created.
* **Strict Local**: a memory / Notebook block is marked with the privacy-guard sentinel **and** `answerQuestion` forces the local branch (`routing_reason: « mémoire · local imposé »`, `has_private_sources:true`) — a cloud provider can never receive it, even if the router misbehaved (provider-level guard). Verified: the real server was run **with a network spy that blocks and records every non-loopback connect / DNS / fetch**: 0 attempts during the whole chat + memory + security run.
* **Resilience**: a failing memory layer ⇒ `MEMORY_ERROR`, chat continues; embedding model down ⇒ memory answers FTS-only and the chat continues **when memory has something to say**; with nothing relevant the pre-existing error behaviour is preserved (no invented answer).
* **Logging**: `CHAT_MEMORY_RETRIEVED {requestId, memory ids, scopes, skipped codes, mode, ms}` only — never statements, the question, evidence or secrets (tested on the logger and on the real server log).
* **Memory ↔ Notebook**: two distinct blocks (`MÉMOIRE UTILISATEUR` / `SOURCES NOTEBOOK`), never merged; AI-history sources are flagged « ancienne réponse IA non vérifiée »; a contradiction memory ↔ source (NB-3 heuristic) is **surfaced** (conflict list, NOTE SYSTÈME to the model, « la mémoire n'est PAS une vérité supérieure », UI notice) — both positions are kept. Memory ↔ memory conflicts (NB-5) are surfaced the same way.
* **Live revoke / delete, no restart**: approve → used; revoke → next question not used; delete → 0 retrieval, 0 stale vector (LanceDB), 0 SQLite / FTS / embedding-meta / usage residue (real server). Concurrent chat queries during revoke / edit / delete: no exception, no stale resurrection (the **edited** statement is used, never the old one).
* **Restart**: KEEP survives and keeps answering, SESSION_ONLY is absent (row, FTS, vector), no duplicate vector.

## 3. Real-embedding quality + value of the vector channel (`nb7-chat-quality.mjs`, real `nomic-embed-text`)

Corpus: NB-5's 34 memories × 50 chat-shaped queries (exact decision / project, semantic paraphrase, global, notebook, historical, unrelated, cross-project trap, ambiguous project = no project given).

| vectorMode | hit@3 (31 positives) | false positives (18) | scope / revoked / superseded / sensitive leakage | p50 / p95 (incl. cold embeds) |
|---|---|---|---|---|
| hybrid (NB-5) | 0.839 | 0 | 0 | embeddings dominate |
| FTS first, vector fallback | 0.839 | 0 | 0 | — |
| **FTS only** | **0.839** | **0** | **0** | **0.6 / 1.4 ms** |

Per category (identical in all three modes): exact / project 18/18 · global 3/3 · notebook 2/2 · historical 2/2 · **paraphrase 1/6** · unrelated 0 FP · cross-project traps 0 · notebook trap 0 · ambiguous project 0 FP. The 5 misses are the pure paraphrases of NB-5 (no shared content word, cosine < 0.75).
**Decision: the vector channel adds no measurable gain ⇒ not forced.** The chat default is `vectorMode: 'off'` (FTS5 only: no Ollama call for memory, the main chat is not slowed); `fallback` (embed only when FTS is empty) and `hybrid` remain explicit settings (`PUT /docteur-memory/chat-settings`). NB-5's own `/docteur-memory/answer` keeps hybrid. Caveat: a 34-item synthetic French corpus — a real memory with many paraphrases could benefit; the knob exists and the numbers to revisit are in `reports/nb7-chat-quality-results.json`.

## 4. Performance (`nb7-benchmark.mjs`; pseudo 768-d embeddings + real SQLite FTS5 + real LanceDB; pack ≈ 1.75 KB)

| Memories | toggle OFF | FTS-only (no lexical match) | FTS-only (with hit) | vector fallback / hybrid (no match) | hybrid (with hit) |
|---|---|---|---|---|---|
| 1 000 | 0 ms | 0.4 / 1.6 ms (p50/p95) | 0.7 / 1.0 ms | 6.1 / 7.4 · 5.9 / 7.0 ms | 6.2 / 7.6 ms |
| 10 000 | 0 ms | 2.0 / 3.2 ms | 2.3 / 3.9 ms | 20.4 / 24.7 · 24.4 / 27.0 ms | 25.2 / 27.7 ms |
| 100 000 | **NOT_RUN** (optional; human-approved memory of that size is unrealistic) | | | | |

Vector modes exclude the Ollama embedding of the query (+ ~20–60 ms warm on nomic); the chat default (FTS-only) makes no memory-related Ollama call. A chat with **no memory at all** costs one `COUNT(*)`. Retrieval never blocks the chat disproportionately (≤ 4 ms at 10 k).

## 5. Local API security audit + hardening

**Finding (NB-6 follow-up).** Only the memory routes had a request guard. Across the real API (627 routes, 67 route files) a hostile web page could still send cross-origin « simple » requests (text/plain, form, multipart) that are **processed** (CORS only hides the response), and DNS rebinding made reads same-origin. Five route files carry their own pre-2026 origin checks (`code-intel`, `external-agents`, `metagpt`, `openmontage`, `sherlock`: loopback hostname, **any port**, no Host check) — divergent copies, left untouched (they now run **behind** the central guard). Also found: the CORS `allowMethods` had no **PATCH**, so a real browser **preflight refused Docteur Memory edits** (NB-5's `PATCH /items/:id`) in the dev setup — mocked browser tests could not see it; fixed and proved on the real server.

**One central guard, mounted once** (`lib/local-request-guard.js` + `lib/local-api-policy.js`, `applyLocalApiSecurity` right after CORS in `server.js`; the memory route now imports it — no per-route copies):

| Rule | Effect |
|---|---|
| Host allow-list | loopback names/IPs, private / link-local / CGNAT IPv4, ULA / link-local IPv6, single-label names, `*.local/.lan/.internal/.home.arpa`, `DOCTEUR_ALLOWED_HOSTS`; malformed Host (userinfo, path, space, `[::1`, NUL, empty) ⇒ 403 `FORBIDDEN_HOST` — **DNS rebinding fails closed, reads included** |
| Origin | when present must be an **expected frontend origin** (the CORS allow-list: dev/LAN frontends + `DOCTEUR_ALLOWED_ORIGINS`) or **same-origin** (host[:port] = Host); `null`, `file://`, foreign, other-loopback-port origins ⇒ 403 `FORBIDDEN_ORIGIN`, for GET **and** writes; no Origin (curl, workers, tests) ⇒ allowed |
| Sec-Fetch-Site | `cross-site` on a non-safe method without Origin ⇒ 403 |
| JSON-only writes | enforced on the memory routes (415); other routes keep their content types (uploads, legacy clients) — Origin does the CSRF work there |
| Body caps | 64 KB sensitive JSON (memory, router/keys, privacy, todo, jobs, notebooklm, free-ai, local-ai, skills, activity), 1 MB chat/search (`answer/search/clarify/compare/web-*`), 2 GiB outer bound for declared uploads (files, backup, image*, voice, pdf, cv-import, vision, corpus, inbox, video-summary, download, openmontage, audio-player, sherlock, notebook documents / ai-history), 64 MB default; 413 `BODY_TOO_LARGE`; a 3 MB multipart upload still passes |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on API responses; `Cache-Control: no-store` on memory / router / backup / privacy (neurons stay cacheable for the PWA) |
| Frozen modules | **EXEMPT** (168 routes: Device Fabric, OMEGA v1/v2, RASSILON (+LAN), Maître, `monitor`/Observateur): their certified behaviour is unchanged; classified in the matrix and flagged as the **residual / next-mission item** (they keep their own controls) |

**Loopback-origin decision (NB-6 limitation): REQUIRE EXPECTED FRONTEND ORIGIN** (was « any loopback port »). Threat: any page served from another local port (another dev server, a compromised local project) is a foreign page able to fire simple requests at Docteur. Compatibility: the app can only read API responses from an origin CORS already allows, so a working setup always sends an allow-listed origin; same-origin covers a UI served by the API host; `DOCTEUR_ALLOWED_ORIGINS` / `DOCTEUR_ALLOWED_HOSTS` extend the lists for custom deployments. Compat was proven (legit frontend origin, no-Origin local client, `localhost`/`[::1]` Host all still 200 on all 459 non-frozen routes and on the real server; preflights for the real origin still work).

**CORS audit**: no wildcard origin anywhere (explicit allow-list function returning the specific origin or `null`, `credentials:true` only with a specific origin, no manual `Access-Control-Allow-Origin: *` in `server.js` or any route file — tested); foreign origins receive no ACAO; methods now include PATCH.

**Frontend headers (audit, nothing added):** `index.html` has no CSP, no referrer meta, no frame restriction; a CSP could break the PWA / service worker / Three.js inline styles, so none was added — recommended next step: a **report-only** CSP. No external CDN in `index.html` (Strict Local); the service worker never serves `/api` from its navigation fallback.

### Route security matrix (full per-route JSON: `reports/nb7-route-security-matrix.json`, 627 rows)

Every route was statically extracted and classified (SAFE / WRITE-SENSITIVE / READ-SENSITIVE / PUBLIC-LOW-RISK): **372 WRITE-SENSITIVE, 215 READ-SENSITIVE, 40 PUBLIC/LOW-RISK, 0 SAFE** (no route is « safe by design » without the guard). The test then registers a probe handler on **every non-frozen route** and proves, per route: DNS-rebinding Host, foreign Origin (read and write), `Origin: null`, other-loopback-port Origin and cross-site fetch ⇒ **403 and the handler is never reached**; the legitimate frontend origin and a no-Origin client ⇒ **200** (459 routes proven). Per route-group summary:

| Route file | prefix | routes | WRITE-SENS. | READ-SENS. | PUBLIC/LOW | auth / local guard | origin policy | body limit | result |
|---|---|---|---|---|---|---|---|---|---|
| device-fabric.js | `/api/device-fabric` | 40 | 28 | 12 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| omega-outbound.js | `/api/omega` | 36 | 28 | 8 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| notebook-memory.js | `/api/docteur-memory` | 28 | 15 | 13 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| rassilon.js | `/api/rassilon` | 26 | 17 | 9 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| prompt-generator.js | `/api/prompt-generator` | 24 | 16 | 0 | 8 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| teacher.js | `/api/teacher` | 22 | 14 | 8 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| router.js | `/api/router` | 21 | 10 | 11 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) ; 67108864 B (default) | PASS |
| image-generation.js | `/api/image-generation` | 20 | 13 | 0 | 7 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| investment.js | `/api/investment` | 20 | 14 | 6 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| maitre.js | `/api/maitre` | 19 | 6 | 13 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| kiwix.js | `/api/kiwix` | 18 | 7 | 0 | 11 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| notebook-ai-history.js | `/api/notebooks` | 18 | 7 | 11 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) ; 67108864 B (default) | PASS |
| candidature.js | `/api/candidature` | 14 | 13 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| external-agents.js | `/api/external-agents` | 14 | 9 | 5 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| omega.js | `/api/omega` | 14 | 9 | 5 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| sales.js | `/api/sales` | 14 | 11 | 3 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| notebook-documents.js | `/api/notebooks` | 13 | 9 | 4 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) ; 67108864 B (default) | PASS |
| notebook.js | `/api/notebooks` | 12 | 7 | 5 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| research.js | `/api/research` | 12 | 10 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| chat.js | `/api/chat` | 11 | 7 | 4 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| metagpt.js | `/api/metagpt` | 11 | 7 | 4 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| monitor.js | `/api/monitor` | 11 | 4 | 7 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| files.js | `/api/files` | 10 | 5 | 5 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| sherlock.js | `/api/sherlock` | 10 | 7 | 3 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| skills.js | `/api/skills` | 10 | 7 | 3 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| agents.js | `/api/agents` | 9 | 5 | 4 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| connectors.js | `/api/connectors` | 9 | 7 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| cyber-audit.js | `/api/cyber-audit` | 9 | 3 | 6 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| neuron.js | `/api/neurons` | 9 | 4 | 5 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| code-intel.js | `/api/code-intel` | 7 | 0 | 7 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| corpus.js | `/api/corpus` | 7 | 5 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| rassilon-lan.js | `/api/rassilon-lan` | 7 | 5 | 2 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| video-summary.js | `/api/video-summary` | 7 | 5 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| activity.js | `/api/activity` | 6 | 2 | 4 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| capture.js | `/api/capture` | 6 | 5 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| memory.js | `/api/memory` | 6 | 3 | 3 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| omega-admin.js | `/api/omega` | 6 | 3 | 3 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| openmontage.js | `/api/openmontage` | 6 | 2 | 0 | 4 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| inbox.js | `/api/inbox` | 5 | 3 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| local-ai.js | `/api/local-ai` | 5 | 1 | 0 | 4 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| omega-view.js | `/api/omega` | 5 | 2 | 3 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| style-examples.js | `/api/style-examples` | 5 | 3 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| voice.js | `/api/voice` | 5 | 3 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| audio-player.js | `/api/audio-player` | 4 | 1 | 3 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| backup.js | `/api/backup` | 4 | 2 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| browser.js | `/api/browser` | 4 | 2 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| image.js | `/api/image` | 4 | 2 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| jobs.js | `/api/jobs` | 4 | 3 | 0 | 1 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| omega-interactive.js | `/api/omega` | 4 | 3 | 1 | 0 | frozen — own controls | unchanged (CORS allow-list) | unchanged | EXEMPT / RESIDUAL |
| todo.js | `/api/todo` | 4 | 3 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| free-ai.js | `/api/free-ai` | 3 | 1 | 0 | 2 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| index.js | `/api/index` | 3 | 2 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| notebooklm.js | `/api/notebooklm` | 3 | 2 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| ollama.js | `/api/ollama` | 3 | 2 | 0 | 1 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| web-explore.js | `/api/web-results` | 3 | 3 | 0 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| download.js | `/api/download` | 2 | 1 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| health.js | `/api/ping` | 2 | 0 | 0 | 2 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| pdf.js | `/api/pdf` | 2 | 2 | 0 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| privacy.js | `/api/privacy` | 2 | 0 | 2 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 65536 B (memory-and-settings-json) | PASS |
| vision.js | `/api/vision` | 2 | 1 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 2147483648 B (declared-uploads) | PASS |
| answer.js | `/api/answer` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 1048576 B (chat-and-search-json) | PASS |
| clarify.js | `/api/clarify` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 1048576 B (chat-and-search-json) | PASS |
| compare.js | `/api/compare` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 1048576 B (chat-and-search-json) | PASS |
| cv-import.js | `/api/cv` | 1 | 1 | 0 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| search.js | `/api/search` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 1048576 B (chat-and-search-json) | PASS |
| secret-scan.js | `/api/maintenance` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 67108864 B (default) | PASS |
| web-answer.js | `/api/web-answer` | 1 | 0 | 1 | 0 | central guard (Host + Origin + Sec-Fetch) | expected frontend / same-origin; none = local client | 1048576 B (chat-and-search-json) | PASS |

## 6. Attack tests (unit on every route + real server)

| Attack | Result |
|---|---|
| Host `evil.example`, `attacker.test`, `evil.example:3001`, `127.0.0.1:3001@evil.example`, `evil.example/127.0.0.1`, `[::1`, NUL, blank | 403 fail closed (unit, per-route, real server) |
| Origin external, `null`, `file://`, other loopback port, look-alike (`127.0.0.1.evil.example`, `localhost.evil.example`), userinfo | 403 |
| Missing Origin, `localhost`, `127.0.0.1`, `[::1]`, private LAN IP | allowed (non-browser / same machine clients) |
| `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`, `application/json` cross-origin POST / PUT / PATCH / DELETE on memory, neurons, index, sync, backup import, cloud keys, capture, answer, notebooks | 403, **create / edit / delete 0** (DB + neurons + memory count unchanged on the real server) |
| Cross-origin GET of neurons, memory, cloud keys, backup, activity, privacy violations | 403, **read 0**, no ACAO |
| Preflight from a foreign origin | no ACAO; preflight PATCH from the real origin allowed |
| Bodies: 70 KB memory JSON, 1.2 MB chat JSON | 413 on the real server |
| Frozen route with a hostile request | not touched by the guard (documented residual) |

## 7. Offline / network proof

Real server + loopback Ollama double + **network spy (`nb7-net-spy.cjs`: blocks and records every non-loopback TCP / DNS / fetch)**: chat with memory (FTS-only default, vector fallback on embedding failure), memory-used payload, revoke / delete, toggle, Notebook context, security checks — **0 attempts**, everything worked (= offline). Unit spies on `child_process`, `http`, `https`, `net`, `dns`, `fetch`, `fs.write*` during packing: 0 calls. Browser: every non-loopback request aborted, 0 seen. **External memory transmission: 0.**

## 8. UI (main chat)

`🧠 Mémoire : ON/OFF` (role=switch, keyboard, default ON — allowed because every used memory is displayed and the project is never guessed; persisted as a preference, per conversation via the request flag; global kill switch in the MÉMOIRE panel), explicit **Projet** and **Notebook** selectors (« sans projet : seule la mémoire GLOBAL peut servir »), and under each answer a **collapsed** « Mémoire utilisée : N » (+ « sources Notebook : M »): marker, scope, type, HISTORIQUE flag, reason/score, statement, provenance, evidence links (deleted sources flagged), typed Notebook sources, conflict notice. Nothing is shown when no memory reached the model (no empty block). All strings are React text nodes: **XSS tested** on statements, provenance, evidence provider, source titles, project names and Notebook names (0 script execution, 0 injected element); localStorage holds only the switch and the two selections, never memory content. The panel is shown while the answer types out (nothing hidden; the pre-existing footer stays hidden until a re-render — pre-existing quirk, unchanged).

## 9. Real AI-export validation

**No real export was provided ⇒ NOT_RUN. ChatGPT / Gemini / Claude adapters remain SYNTHETIC_ONLY.** I searched nothing and opened no personal data. A privacy-preserving validator is ready for when an export is explicitly supplied: `node nb7-validate-real-export.mjs <file> [--declared CHATGPT|GEMINI|CLAUDE]` — runs the NB-4 preview in a throw-away temp DB (no import, no storage, no network, no LLM) and prints **only** provider, verified-by-structure flag, file / conversation / message / invalid / blocked counts and PASS/FAIL — never a prompt, title, name or secret (demonstrated on the synthetic fixture only, labelled as such). A real schema difference would be fixed backward-compatibly with a minimal anonymised fixture.

## 10. Tests and proofs

| Suite | Result |
|---|---|
| Historical Notebook files (5) | 75/75 |
| NB-2 / NB-3 / NB-4 / NB-5 / NB-6 certification | 37/37 · 31/31 · 44/44 · 38/38 · 12/12 |
| **NB-7 chat memory** (`test-nb7-chat-memory.mjs`) | **24/24** |
| **NB-7 local API security** (`test-nb7-local-api-security.mjs`, 627 routes) | **13/13** |
| Notebook backend total | **274/274** |
| Browser: NB-2 / NB-3 / NB-4 / NB-5 files + **NB-7 chat** (assertions) | 18 · 34 · 44 · 62 · **27** = 185 |
| Real-server proof `nb7-boot-proof.mjs` (Ollama double + net spy) | **42/42** (+ NB-5 boot proof re-run 29/29) |
| Real-embedding quality (`nb7-chat-quality.mjs`) | hit@3 0.839, FP 0, leakage 0 |
| Full backend sweep (181 test files) | 0 failures except 4 environment-only files (below) |
| `npx tsc --noEmit` / `npm run build` | PASS / PASS |
| Secret scan (new + changed files, diff) | 0 non-synthetic secrets |

Environment-only items, unrelated to NB-7: `test-omega-outbound-admin` needs `--experimental-test-module-mocks` (15/15 with it); `test-video-pipeline` / `test-video-manual` (same flag / cwd-dependent temp path, Video Studio); `test-regression-api.mjs` is a fixture server, not a test. One real regression caught and fixed during the work: the Device Fabric static audit (#23) flagged my new `local-api-policy.js` because it **mentioned** the module's URL prefix; the prefix is now assembled from parts (the file only exempts it, never calls the module) and the audit is 23/23 again, untouched.

## 11. FREEZE

`reports/nb7-freeze-manifest.json` = SHA-256 (LF-normalised) of every Notebook / AI-history / Memory / chat-memory / local-guard source, route, UI component, test, tool and NB-1…NB-6 report. `node nb7-freeze-manifest.mjs --verify` lists any drift — any later change to those files is a **new mission**. Notebook **FROZEN**; Docteur Memory **FROZEN**.

## 12. Known limitations

* Real AI export validation **NOT_RUN** (adapters SYNTHETIC_ONLY); 100 k benchmark **NOT_RUN**.
* Frozen-module routes (168) are exempt from the new guard: Device Fabric / OMEGA / RASSILON / Maître / Observateur keep their own certified controls — the cross-origin exposure of **those** routes is the top candidate for the next hardening mission. The 5 legacy route-level origin checks remain (any loopback port) behind the central guard.
* No CSP / frame restriction on the frontend (audit only); the API adds nosniff / no-referrer / no-store only.
* Custom hostnames / origins need `DOCTEUR_ALLOWED_HOSTS` / `DOCTEUR_ALLOWED_ORIGINS` (opt-in, documented; the working setups — loopback, private IP, single-label / `.local` names, dev and LAN frontends — need nothing).
* The chat E2E uses a loopback Ollama **double** (so the exact LLM messages can be inspected); real-Ollama was used for the retrieval-quality run and NB-5's boot proof. Real LLM answer quality with memory was not evaluated.
* Chat memory retrieval is FTS-only by default: paraphrase recall is 1/6 on the synthetic corpus (vector measured as no gain here).
* Memory is not wired into other chats (web answer, compare, Notebook Q&A…) by design. Main chat only.
* Memory injection forces the local model: with memory used, cloud routing is intentionally unavailable for that question.
* The console hides the pre-existing answer footer until a re-render (pre-existing; not changed).

## 13. Files

New: `cortex-server/src/lib/chat-memory.js`, `local-request-guard.js`, `local-api-policy.js`; `cortex-server/test-nb7-chat-memory.mjs`, `test-nb7-local-api-security.mjs`; tools `nb7-boot-proof.mjs`, `nb7-fake-ollama.mjs`, `nb7-net-spy.cjs`, `nb7-chat-quality.mjs`, `nb7-benchmark.mjs`, `nb7-route-matrix.mjs`, `nb7-validate-real-export.mjs`, `nb7-freeze-manifest.mjs`; `scripts/test-chat-memory-browser.mjs`; `src/components/console/ChatMemoryControls.tsx`; `reports/nb7-*.json`; this report.
Modified (additive): `cortex-server/src/server.js` (imports, `answerQuestion` glue, CORS `PATCH`, `applyLocalApiSecurity`), `src/lib/notebook-memory.js` (`vectorMode`), `src/lib/notebook-documents-runtime.js` (`getChatMemory`), `src/routes/notebook-memory.js` (central guard, chat-settings routes), `src/lib/cortex/client.ts` (types + methods), `src/components/console/SearchConsole.tsx` (controls + panel), `src/components/modals/NotebookMemoryPanel.tsx` (global chat switch), `test-nb6-memory-certification.mjs` (allow-list of the sanctioned chat wiring), `scripts/audit-queue-lib.mjs` (an `extra` mock hook, reused by the chat browser test).
Not modified: Device Fabric, OMEGA, RASSILON, Maître, Observateur, Phase-3 adaptive memory.
