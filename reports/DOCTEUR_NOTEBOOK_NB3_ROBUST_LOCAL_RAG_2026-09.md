# DOCTEUR NOTEBOOK — NB-3: robust local RAG, citations, retention, quality calibration

Date: 2026-09-30 · Uncommitted (no `git add/commit/push/reset/clean/stash`).
Builds on NB-2 (`DOCTEUR_NOTEBOOK_NB2_STRICT_LOCAL_MVP_2026-09.md`). The Notebook was **extended, not rebuilt**:
SQLite + FTS5, LanceDB, the Ollama abstraction, `nomic-embed-text`, versioning, chunk/page provenance,
injection isolation, secret scanning and Strict Local are all preserved and re-tested.

## 0. Baseline (before any change)

`git status` = the two earlier missions' uncommitted work (YouTube Shorts, NB-1/NB-2 files). Baseline re-run:
5 historical Notebook files **75/75**, NB-2 suite **37/37** (= 112/112 backend), Notebook browser **17/17**. 0 failures → work started.

## 1. Real embedding calibration — `REAL_EMBEDDING_CALIBRATION: PASS`

- Ollama + `nomic-embed-text` (768-d, already installed; **nothing installed or pulled**). Ollama was not running: I started
  `ollama serve` locally for the run (and the tray app was started as a side effect of `ollama list`); both were stopped afterwards.
- Harness: [nb3-calibrate.mjs](../cortex-server/nb3-calibrate.mjs) on the controlled synthetic corpus
  [nb3-corpus.mjs](../cortex-server/nb3-corpus.mjs): **26 documents** (FR, EN, mixed, technical, contradictory pairs, near
  duplicates, 3 distractors, one long handbook, one HTML table) and **52 queries** (44 with known relevant sources, 8 negatives
  with no relevant document) covering all requested query types. It runs the *production* `service.search` with an injected
  exact-cosine vector store, then verifies parity against real LanceDB (**52/52 identical result lists**).
  Raw results: [nb3-calibration-results.json](nb3-calibration-results.json).
- Metrics: hit@1, hit@3, MRR, recall@6, precision, false-positive rate on negatives; objective
  `J = 0.30·MRR + 0.25·recall + 0.10·precision + 0.35·(1 − FP)` (precision-first: a wrong answer is worse than no answer).

### 1.1 Findings

| Mode (nomic task prefixes) | hit@1 | hit@3 | MRR | recall | FP on negatives | J |
|---|---|---|---|---|---|---|
| FTS5 only | .886 | .886 | .886 | .879 | 0 | .921 |
| vector only (thr .6) | .523 | .545 | .534 | .527 | .25 | .596 |
| hybrid, NB-2 defaults (thr .6, cov .5) | .909 | .955 | .932 | .936 | .25 | .851 |
| **hybrid, NB-3 calibrated** | .932 | .932 | .932 | .913 | **0** | .946 |

- **NB-2's synthetic calibration was wrong for real vectors.** The unit-normalised real embeddings put unrelated text at
  cosine 0.45–0.70 (negative queries' top chunk: median .53, **max .647 with prefixes / .704 without**) while the best chunk of a
  relevant document has median .615 and p10 **.52**. Absolute similarity separates poorly; NB-2's 0.35 floor (on an L2-based score)
  would have returned junk for almost every query.
- Per query type (calibrated, precise profile), hit@3: every lexical/structural type = 1.00 (exact keyword, acronym, filename,
  heading, multi-word, natural-language question, French accents, English, technical identifier, rare term, long-document fact,
  table, contradiction pair, mixed language). **Weak spots, stated plainly:** semantic paraphrase **0.33** (recall .17) and
  French query against English document **0.67**. The 3 failures are all vector-dependent queries that fall under the precision floor.
- Task prefixes: `search_document:` / `search_query:` (nomic's trained format) improved the hybrid baseline
  (hit@1 .909 vs .750 raw) and the tuned optimum (J .953 vs .946) → adopted as embed format `nomic-prefix-v1`, **stored with every
  vector**; NB-2 vectors (`raw-v0`) are treated as incompatible until an explicit reindex.
- Metric fix: LanceDB search now uses cosine distance (`score = cosine`), not squared-L2.

### 1.2 Threshold / RRF / rerank decisions (grid over 7 thresholds × 5 lexical-coverage floors × 3 RRF constants × 4 weightings × 2 rerankers)

| Parameter | Chosen | Evidence |
|---|---|---|
| vector cosine floor | **0.70** | thr ≤ 0.60 ⇒ FP 25–87 % on negatives; 0.65 ties (J .953) but sits 0.003 above the highest negative (.647) — with only 8 negatives I chose the plateau centre (0.70, margin .05) |
| lexical coverage gate | **0.34** | fraction of content-bearing (stop-word-free, accent-folded) query terms present in the chunk; 0 ⇒ FP ≥ .25, ≥ .5 loses 1–2 hits |
| RRF constant | **60** | 10 / 30 / 60 gave identical J — no measurable effect at these candidate sizes; kept the standard value |
| FTS : vector weight | **1 : 0.5** | FTS is measurably stronger on this corpus; 1:1 −0.003, 0.5:1 −0.004 (within noise — not over-claimed) |
| rerank | **none (RRF only)** | coverage rerank +0.000 J → no benefit, no dependency added |
| agreement floor (lower vector floor for lexically supported chunks) | not enabled | +0.000 J |
| chunk overlap | **150 unchanged** | see §6 — no measurable retrieval benefit, but costs +50 % chunks on oversize blocks; documented, not changed |

A named `broad` profile (`vectorThreshold .6`) is exposed to the user ("Recherche large") for paraphrase recall: measured
J .853 / FP .25 — a deliberate precision trade-off, never the default.

**Caveat:** 52 queries on a synthetic corpus give wide uncertainty (one query = ±2 pts of hit@3). The pinned defaults are guarded by
a real-embedding regression test (hit@3 ≥ 0.9, 0 false positives), but should be re-checked on the user's real documents (NB-4).

## 2. Retrieval pipeline (what runs now)

```
query ─► content terms (stop-words out, accents folded)
      ├► FTS5 (bm25, quoted terms) ─► lexical-coverage gate ≥ 0.34 ─┐
      └► embed (nomic-prefix-v1) ─► LanceDB cosine (notebook-scoped) ─► compat check (provider+model+dim+format)
                                    ─► cosine floor ≥ 0.70 ────────┤
      weighted RRF (1 : 0.5, k = 60) ─► exact / normalised / 3-shingle near-duplicate suppression
      ─► round-robin source diversity (≤ 3 per source) ─► context budget (3000 tokens est., ≤ 6 chunks)
      ─► conflict detection ─► 3-message prompt (fixed system / untrusted sources / verbatim user) ─► local LLM
      ─► citation verification against the DB ─► structured answer
```

`NO_RELEVANT_SOURCE`: when nothing passes the gates the **LLM is not called** and no Notebook answer is fabricated. Optional
`allowOutsideNotebook` (explicit checkbox) gives a general answer, prefixed « Hors Notebook », with no citation and status
`OUTSIDE_NOTEBOOK`.

## 3. Answer contract

`{ status: ANSWERED | NO_RELEVANT_SOURCE | OUTSIDE_NOTEBOOK, answer, citations[], uncertainties[{code,message}], sourceConflicts[],
retrievalMode (HYBRID | FTS_ONLY), mode, vectorStatus, sourcesUsed[], confidence (HIGH|MEDIUM|LOW|NONE), diagnostics }`.
Each citation carries `assertionType`: `SOURCE_FACT`, `USER_ASSERTION` (USER_AUTHORED), `PAST_AI_ASSERTION` (PAST_AI_OUTPUT).
An answer with no citation is flagged `NO_CITATION_IN_ANSWER` = unsupported `MODEL_INFERENCE`; `UNKNOWN` is expressed by
`NO_RELEVANT_SOURCE`. Confidence is a deterministic heuristic (top-hit lexical coverage + cosine + agreement of both lists), not a probability.

## 4. Citations

Granularity: `sourceId, documentVersion, versionId, chunkId, page, headingPath, startOffset, endOffset, hash, trustLevel, superseded`.
A citation is accepted only if its `[N]` is inside the pack **and** the chunk exists in *this* notebook, is visible (not expired /
not another session) and its `versionId` and text `hash` equal what was retrieved. Rejected & tested: fake chunk id, wrong version,
wrong hash (tampered pack), wrong notebook, deleted, expired. Preview = the exact stored chunk text (byte-equal to `nb_chunks.text`),
never a re-derived excerpt; a superseded version stays resolvable and is labelled. UI: every citation/hit is a button → preview
dialog (source, version, page, heading path, offsets, trust), Escape closes and focus returns to the trigger.

## 5. Contradictions, recency, trust, diversity

- **Contradictions** (`notebook-conflicts.js`): local deterministic heuristic on sentence pairs from different sources (or versions):
  `POLARITY` (FR/EN lexicon + negation parity: actif/désactivée, enabled/disabled, supportée/n'est pas supportée), `NUMERIC`
  (10 vs 100 Mbit/s), `VERSION` (same document, old vs new sentence). Returned as `sourceConflicts[]` with both citations, versions,
  import dates, page, excerpts; a machine-generated NOTE SYSTÈME (ids/types only, outside the untrusted blocks) tells the model to
  present both positions. **Heuristic ⇒ false positives/negatives possible, labelled `heuristic: true`.** Not semantic.
- **Recency**: current version only by default; `includeHistorical` (UI: « Anciennes versions ») adds superseded chunks
  (FTS-only, their vectors are deleted), flags them `isCurrent:false`, reports `mixedVersionDocuments`, adds
  `HISTORICAL_VERSION_MIXED` and a `VERSION` conflict.
- **Trust levels** (USER_AUTHORED, PRIMARY_SOURCE, VERIFIED_EXTERNAL, SECONDARY_SOURCE, PAST_AI_OUTPUT, UNVERIFIED_WEB, UNKNOWN):
  metadata on document + chunks; editable; retrieval filters `all | trusted | user_authored | selected sources`. PAST_AI_OUTPUT is
  **never excluded automatically** — it is labelled and flagged `PAST_AI_SOURCE_USED`. Test: `USER_AUTHORED` does not bypass secret
  blocking; trust is never consulted for any permission.
- **Diversity**: round-robin so a long document cannot crowd out other sources (test: 12-section document + 4 notes ⇒ ≥ 5 sources,
  ≤ 3 chunks each); 5-source answers cite 5 distinct sources; duplicate content is not a sixth source.

## 6. Chunking / overlap / budget

Chunks never span two headings or two pages (a NB-3 fix: previously a small following section was merged and cited under the first
heading — caught by a citation test). HTML tables become row text (`Clavier Nimbus | 89 euros`). Overlap experiment on ~2000-char
paragraphs: overlap 0 → 24 chunks, 150 → 36, 300 → 36, target 500 → 60, target 1400 → 24; **fact retrieval 12/12 in every variant** ⇒ no
measurable gain from overlap on this corpus; 150 kept (≈ 11 % of the max chunk, sentence-boundary splits) but flagged for re-evaluation
on real documents. Context budget: ≤ 6 chunks, ≤ 3000 estimated tokens, ≤ 3 per source; a single oversize chunk is truncated to the
budget, never a whole document.

## 7. Embedding-version safety and REINDEX

Every vector's metadata stores provider, model, dimension, embed-format version, chunk hash. A search never compares vectors whose
provider / model / dimension / format differ (tested with all four) → `vectorStatus: VECTOR_STALE`, `retrievalMode: FTS_ONLY`, FTS still
works. `POST /notebooks/:id/documents/:docId/reindex` and `POST /notebooks/:id/reindex` re-embed **only on an explicit user action**
(UI button « Réindexer les vecteurs », shown only when needed); a failed reindex leaves the previous vectors intact; no automatic
re-embedding happens on search or boot.

## 8. FTS-only mode

Provider down ⇒ import still `READY`, `VECTOR_UNAVAILABLE`, search/ask/preview/delete all work, no cloud fallback, no silent claim:
the UI shows « Recherche texte locale », the answer carries an `FTS_ONLY` uncertainty. Verified on a real server with Ollama unreachable
(NB-2) and in the NB-3 suite; « Réindexer » restores vectors.

## 9. Retention

| Policy | Behaviour | Verified |
|---|---|---|
| KEEP | default, no expiry | never purged after a simulated 1000 days |
| MANUAL | **behaviourally identical to KEEP** — only the label differs ("user chose never auto-delete"); no invented difference | same test |
| DELETE_AFTER `1m…365d` (`1h`, `24h`, `7d`) | invisible to every query the instant it expires (visibility filter in SQL); bounded sweep (50/5 min, boot 500) frees rows, FTS, embedding metadata, LanceDB vectors, notebook source | clock-injected test + counts = 0 |
| SESSION_ONLY | usable this session; a new server session purges it at boot **and** other-session rows are invisible even before the purge | service test **and a real server restart** (below) |

**Honest limit of SESSION_ONLY:** the data *is* written to SQLite/LanceDB during the session (a memory-only store would need a second
storage engine); the guarantee is *absence after restart*. A crash leaves rows on disk until the next boot, but no other session can see
them. Real restart proof (isolated temp DB + LanceDB, real Ollama, port 3921): before restart the session document had
`document 1 / versions 1 / chunks 1 / fts 1 / embeddingMeta 1 / vectors 1 / notebookSource 1`; after restart **all 0**, while the KEEP and
DELETE_AFTER documents were untouched. The retention job is local, bounded, `unref`'d, no scheduler dependency, no agent, no Device Fabric.

## 10. Deletion guarantees & import/delete races

After delete / expiry: SQLite row 0, versions 0, chunks 0, FTS 0, embedding metadata 0, LanceDB vectors 0, retrievable chunk 0, citation
preview `null`, `notebook_sources` row gone (all asserted). Races (real code paths with gates): delete during embedding; delete **while the
vector upsert is in flight** (after the SQLite commit — the late upsert is undone, 0 vectors, 0 embedding rows); delete while queued
behind the limiter; whole-notebook purge mid-import. The commit transaction refuses to insert for a deleted document
(`SOURCE_DELETED`) — no late chunk insertion, no vector resurrection. Fixed during NB-3: an in-flight upsert used to leave orphan
embedding metadata.

## 11. Security regressions

Hostile documents (IGNORE SYSTEM, RUN POWERSHELL, CALL OMEGA, CONTROL DEVICE, SEND EMAIL, UPLOAD FILE, EXFILTRATE SECRET) plus an
**indirect** injection (source A instructs what to do "when source B is read"): the LLM stub answers with malicious intent; asserted: 0
`child_process` calls (spawn/exec/execFile/fork/*Sync all trapped), 0 `fetch`, system prompt byte-identical, user message verbatim, no
action channel in the answer contract, `[9]` citation dropped, ≥ 6 chunks flagged. Injection heuristics were extended (control
device, send message, French exécute/envoie…). Secrets: after `REDACT` the original value is not retrievable by FTS, vector query, or
`LIKE` on chunks/FTS; after `BLOCK` no chunk and no vector exists. Cross-notebook: same title, filename, content and vectors in A and B →
0 leakage in FTS, vectors, preview and verification; deleting in A does not touch B.

## 12. Strict Local network proof, offline, Google Fonts

- **Backend (NB-3 suite):** every non-loopback connection refused and recorded (fetch, http/https, net.connect); import
  (TXT/MD/HTML with a remote-fetching script/`<img>`/`<link>`/JSON) → search → ask → preview → purge: **0 attempts**. The real-Ollama
  test asserts every host it touched is loopback (`127.0.0.1:11434`).
- **Browser:** every non-loopback request aborted in the Playwright context; the full UI flow works; 0 attempts, 0 page errors.
- **Google Fonts — audited and removed (option A).** The app loaded `fonts.googleapis.com` / `fonts.gstatic.com` at startup from three
  places: `index.html` (2 preconnects + stylesheet), `globals.css` (`@import`), and Workbox runtime-caching rules in `vite.config.ts`.
  All removed; font stacks in Tailwind/`globals.css` now fall back to system fonts (Cascadia Mono/Consolas, Segoe UI). IBM Plex Mono /
  Space Grotesk are still used **if installed locally**; nothing was downloaded. Inline `fontFamily` strings in ~15 components keep
  their names and fall back to the generic families. **Not visually reviewed by screenshot** — a cosmetic change to check.
  `dist/` contains 0 references to those hosts. **This does not mean "0 network for the whole application":** other opt-in features can
  still reach external hosts (e.g. the gesture camera downloads its MediaPipe model from `storage.googleapis.com` when enabled, cloud
  providers when the user turns them on, YouTube/Maps embeds and links). Only the Notebook data path and the startup UI are certified here.

## 13. Performance ([nb3-benchmark.mjs](../cortex-server/nb3-benchmark.mjs), `nb3-benchmark-results.json`)

Real SQLite FTS5 + real LanceDB (768-d, flat scan, no ANN index) + real `service.search`; big-corpus vectors are random unit vectors
(latency/memory only). Query latency p50 / p95 in ms:

| Corpus | Indexing | FTS SQL only | FTS via service | Vector (LanceDB) | Hybrid via service | RSS | SQLite |
|---|---|---|---|---|---|---|---|
| 100 docs / 600 chunks | 0.2 s | 0.3 / 0.6 | 2.0 / 3.7 | 4.5 / 6.6 | 8.2 / 12.4 | 137 MB | 3.6 MB |
| 1,000 docs / 6k chunks | 1.8 s | 1.3 / 4.5 | 3.6 / 7.4 | 22.8 / 25.4 | 29 / 33 | 227 MB | 26 MB |
| 10k chunks | 2.6 s | 3.0 / 9.2 | 5.8 / 12.8 | 40 / 45 | 64 / 80 | 247 MB | 62 MB |
| 100k chunks | 19.7 s | 38 / 99 | 39 / 103 | 168 / 180 | **356 / 414** | 323 MB | 457 MB |

Real embedding throughput (Ollama, sequential, ~900-char chunks): **28 ms / chunk**. The first run exposed two hot-path costs that were
fixed: an O(chunks) vector-status aggregate on every search (now derived from the hits, cached 10 s and invalidated on every write —
100k FTS 291 → 39 ms) and O(n²) shingle rebuilds in duplicate suppression (7.8 → 1.5 ms at small scale). 1M chunks: `NOT_RUN`.
The flat vector scan grows linearly — an ANN index is a NB-4 question above ~100k chunks.

## 14. Pagination / limits

Documents list `limit ≤ 200` / `offset` (default 50); search `limit ≤ 20`, `offset ≤ 40`, hard pool cap 60; citations ≤ 20; conflicts ≤ 10;
sources_used ≤ 20; chunk text truncated to 600 chars in search JSON; `top_k` ≤ 20; `document_ids` ≤ 100. Invalid `trust_filter`,
`profile`, retention, duration, trust level ⇒ 400.

## 15. `/ask` unification audit (decision: **NB-4**)

| Legacy endpoint | Data it reads | With `source_type='document'` sources |
|---|---|---|
| `POST /notebooks/:id/ask` | LanceDB `neurons` by source id (`retrieveForQuestion`) | document ids match no neuron ⇒ ignored (verified: `chunks_used 0`, no leak of document text) |
| `GET /notebooks/:id/summary` | `getNeuronsByIds` | documents contribute nothing (cache hash still changes) |
| `POST …/export-for-notebooklm` | neuron content | prints « (contenu indisponible) » for documents |

Unifying would change what `/ask` and the export return for existing notebooks. Per the "no silent behaviour change" rule it needs an
explicit opt-in (`include_documents`), a merged answer contract, chunk-based summary and export — too large to certify here. The legacy
contract is pinned by a test (`{answer, chunks_used, citations}`, 0 document text). Deferred to NB-4.

## 16. Real PDF, DOCX

- **Real PDF: PASS** — two real third-party PDF files shipped in `external/MetaGPT` (a real text invoice and a tiny sample; not user
  documents) are imported, page = 1 provenance stored, an identifier (`91011111AA2AAAAA00`) is found and its citation preview shows page 1.
  The invoice text is Chinese: only ASCII identifiers were asserted — FTS5 `unicode61` CJK segmentation was **not** validated. OCR out of scope.
- **DOCX: NOT_IMPLEMENTED** — no DOCX/zip library is a dependency; none was audited (license, maintenance, Windows, security). Nothing installed.

## 17. UI / accessibility / XSS

Retrieval-mode label (`role=status`), vector status, reindex button (only when needed), trust selector + PAST_AI colour, retention
selector/duration + badges, source filters (all / trusted / mine / selection with checkboxes, historical versions, broad profile,
outside-Notebook opt-in), conflict block (`role=alert`) showing both sources with version and date, uncertainties, confidence,
citation/hit buttons with `aria-label`s, preview `role=dialog` with focus management, delete needs an in-page confirmation whose confirm
button takes focus. Keyboard-only paths tested (Enter on citation, Escape, delete confirmation). Hostile title, heading, filename,
excerpt and conflict text (`<img onerror>`, `<script>`) render as text: `window.__xssFired` stays undefined and no element is created.
Backend contract normalised in the client so an older server response cannot crash the panel.

## 18. Tests

| Suite | Result |
|---|---|
| 5 historical Notebook files | 75/75 |
| `test-nb2-notebook-documents.mjs` | 37/37 |
| `test-nb3-notebook-rag.mjs` (new; includes REAL nomic test and REAL PDF test — both ran, none skipped) | 31/31 |
| **Notebook backend total** | **143/143** |
| Notebook browser: NB-2 file / NB-3 file (new) | 18/18 · 34/34 (**52**) |
| All `test-phase*` + `test-batch-*` + Shorts | 0 failures |
| `npm run build` (runs `tsc`) | PASS, `dist` free of font-CDN references |
| Server boot ×2 (isolated temp DB/LanceDB, real Ollama): migration, import, hybrid search, restart purge, shutdown | PASS; one listener only (127.0.0.1:3921) |
| Diff/new-file secret scan | 0 non-synthetic secrets (fixtures are `FAKE`) |

**Existing tests that had to change (documented, not silently):** the NB-2 file's `makeService` now passes `embedFormat: {}` (fake vectors
are not nomic-trained), the answer-contract assertion became "NB-2 keys are all still present", the retention test now checks invalid
values instead of "only KEEP", and the RRF score assertion uses the calibrated weights. The NB-2 browser test now confirms deletion
through the new in-page confirmation and asserts 0 static external assets (was: log the 3 font requests) → 17 → 18 assertions.

## 19. Limitations

- Calibration corpus is small and synthetic (26 docs / 52 queries, 8 negatives) — direction is reliable, exact optimum is not; re-check on real documents.
- Semantic-paraphrase and cross-language recall are weak under the precise default (hit@3 .33 / .67); `broad` trades precision for recall (FP ≈ 25 %).
- `nomic-embed-text` similarity is a weak *absolute* relevance signal here; FTS carries most of the precision.
- Contradiction detection is a lexicon/heuristic (FR/EN), not semantic.
- SESSION_ONLY touches disk during the session (see §9); MANUAL ≡ KEEP.
- Vector search is a flat scan; 1M chunks not run; benchmark vectors are random.
- FTS5 CJK tokenisation not validated; no OCR; DOCX not implemented.
- Legacy `/ask`, `/summary`, NotebookLM export do not see raw documents (NB-4).
- Google Fonts removed but fallbacks not screenshot-reviewed; other app features can still use external hosts (§12).
- `client.ts` / `App.tsx` also hold the uncommitted YouTube-Shorts changes from an earlier mission.
