# DOCTEUR NOTEBOOK — NB-2: Strict Local MVP extension

Date: 2026-09-30 · Status: implemented, uncommitted (no `git add/commit/push`).
Builds on NB-1 (`DOCTEUR_NOTEBOOK_NB1_ARCHITECTURE_SECURITY_PRIVACY_2026-09.md`). The Phase 5/5B
Notebook was **extended, not rebuilt**: existing tables, routes, tests and the neuron-based Q&A are unchanged.

## 1. Baseline (before any change)

- `git status` at start: only the earlier YouTube-Shorts work (deep-capture/ytdlp/capture/App.tsx/client.ts) + the NB-1 report.
- The "178/178" figure is the cumulative Phase 0-5B suite count. It is not one runnable command. Reproduced instead:
  the 5 test files that exercise the Notebook (`test-phase5-notebook`, `test-phase5b-notebooklm`,
  `test-batch-b-notebook-performance`, `test-batch-a-robustness`, `test-batch-d-connectors`) = **75/75 PASS** before
  and after; and all `test-phase*.mjs` / `test-batch-*.mjs` files = 0 failures after (incl. phase-1 egress certification).

## 2. Architecture implemented

```
file / pasted text ─► validate (ext, size, magic, path) ─► hash ─► duplicate? ─► [limiter: max 2 concurrent, queue 50]
   QUEUED → SCANNING → PARSING → SCANNING(secrets) → CHUNKING → INDEXING → READY
                                              └► SECURITY_BLOCKED / FAILED (explicit error code)
   INDEXING = embed each chunk (Ollama, loopback) → ONE atomic SQLite swap (chunks + FTS5 + current version)
              → LanceDB `notebook_chunks` upsert → READY
search:  FTS5 (bm25, quoted query)  +  LanceDB vectors (notebook-scoped predicate)  ─► RRF fusion ─► dedup by chunk hash
         ─► per-source cap (3) ─► citation pack ─► 3-message prompt (SYSTEM / RETRIEVED SOURCES / USER) ─► local LLM
         ─► citations validated against the DB (never invented, never stale)
```

New files (all under `cortex-server/src/` unless noted):

| File | Role |
|---|---|
| `lib/notebook-parsers.js` | TXT / MD / PDF / HTML / JSON parsers, path + format + size validation, limits |
| `lib/notebook-chunker.js` | deterministic structured chunker (page, heading path, offsets, sha256) |
| `lib/notebook-security.js` | secret scanner, injection heuristics, citation pack, isolated prompt construction |
| `lib/notebook-docs-store.js` | additive SQLite schema + queries (documents, versions, chunks, FTS5, embedding metadata) |
| `lib/notebook-documents.js` | service: import pipeline, versioning, hybrid retrieval, citations, deletion, limiter |
| `lib/notebook-documents-runtime.js` | shared instance wiring (Ollama embed/chat — the existing local path) |
| `routes/notebook-documents.js` | REST routes (import, list, detail, delete, delete-version, reembed, doc-search, doc-ask, citation) |

Existing files touched (small, additive): `lib/lancedb.js` (3 new exported functions for a second table in the
*same* LanceDB database), `routes/notebook.js` (purge documents on notebook delete / document-source delete),
`server.js` (2 lines: mount the route), `src/components/modals/NotebookModal.tsx` (DOCUMENTS tab + STRICT LOCAL badge),
`src/lib/cortex/client.ts` (types + 5 client methods). New UI: `NotebookDocumentsPanel.tsx`.
**No frozen module touched** (Device Fabric, OMEGA V1/V2, RASSILON, MAÎTRE, Observateur: 0 files).

## 3. DB migrations (non-destructive)

`ensureNotebookDocsSchema()` runs at route/service creation (server boot): `CREATE TABLE/INDEX IF NOT EXISTS` only.
Existing `notebooks`, `notebook_sources`, `notebook_summaries` are never altered. Tables:
`nb_documents` (documentId, notebook, title, mimeType, hash, size, language, createdAt, updatedAt, currentVersionId,
status, trustLevel, retention, origin, canonicalUri, errorCode), `nb_document_versions` (versionNo, file hash, text hash,
importedAt, sourceMeta JSON, vectorStatus, isCurrent), `nb_chunks`, `nb_chunks_fts` (FTS5: text, title, heading,
source name; `unicode61 remove_diacritics 2`), `nb_chunk_embeddings` (provider, model, dimension, chunk hash, createdAt).
Each imported document also gets a `notebook_sources` row (`source_type='document'`, `privacy=1`, `local_only`), so the
existing source list, counts and derived-privacy logic keep working. Idempotency is tested.

## 4. Parsers

| Format | Implementation | Safety |
|---|---|---|
| TXT / Markdown | UTF-8 decode; MD keeps heading hierarchy | NUL bytes ⇒ rejected (binary masquerading) |
| PDF | existing `pdf-parse` v2, in memory, per-page text ⇒ `pageNumber` kept | `%PDF` magic, password/scan detection, no OCR |
| HTML | existing `jsdom`, **no `runScripts`, no resource loading**; script/style/iframe/object/embed/form/svg removed; text + heading path only | scripts never run, nothing fetched |
| JSON | `JSON.parse` (never eval), flattened to `path: value` lines | size + depth (32) caps |
| DOCX | **NOT implemented** — no DOCX/zip library is a dependency and none was audited (license, maintenance, Windows, security). `.docx` ⇒ `UNSUPPORTED_FORMAT` | — |

File security before parsing: extension allow-list, size cap, filename sanitising (basename only), path import only from
explicitly allowed roots (`NOTEBOOK_IMPORT_ROOTS`, empty by default ⇒ disabled): rejects `..`, NUL, outside root,
directories, symlink escape (realpath). Limits (env-overridable): 10 MB file, 2 M extracted chars, 5000 chunks.

## 5. Versioning

Same bytes (hash of a *current* version) ⇒ `duplicate:true`, no new rows. Same filename, new bytes ⇒ new `DocumentVersion`
(version_no+1); the old version's chunks stay in `nb_chunks` (`is_current=0`) so old citations still resolve
(flagged `superseded`), but their FTS rows, embedding metadata and vectors are removed so they are never retrieved.
Deleting the current version promotes the previous one (FTS re-indexed, re-embedded); deleting the last removes the document.
The version swap is a single SQLite transaction.

## 6. Chunking

Deterministic; target 1000 chars, hard max 1400, min 200 (small tails merged), 150-char overlap when a block must be
split at a sentence/whitespace boundary. Chunks never cross a page boundary (page-exact citations). Every chunk stores
version, ordinal, page, headingPath, start/end offset, sha256.

## 7. FTS5 / LanceDB / hybrid retrieval

- FTS5 indexes only current-version chunks, filtered by `notebook_id`, current state and document existence.
  User input is tokenised and every token quoted — FTS operators / column filters cannot be injected.
- LanceDB: same database, table `notebook_chunks` (ids only; text lives in SQLite). Search is pushed down with
  `notebook_id = …` (+ optional source ids) — no cross-notebook query exists.
- Fusion = **Reciprocal Rank Fusion**: `score = Σ 1/(60+rank)` over the FTS list and the vector list. Explicit, testable
  (the test recomputes it), returned per result with `ftsRank` / `vectorRank`.
- Vector floor 0.35 (same as chat retrieval in `server.js`); nearest-neighbour noise is not a hit. Vectors from another
  model/dimension are excluded (never compared). Exact-hash duplicate chunks collapse; ≤3 chunks per source.
- Ollama down ⇒ `VECTOR_UNAVAILABLE`, import still `READY`, search `mode:'fts_only'`; `reembed` restores vectors later.
  Verified against a **real booted server with an unreachable Ollama**.

## 8. Prompt-injection & tool isolation

- Three separate messages: SYSTEM INSTRUCTIONS (fixed) / RETRIEVED SOURCES / USER REQUEST (verbatim).
  Each chunk sits inside a **per-request random boundary**; the system prompt declares the content untrusted data and
  forbids treating it as instruction, tool access, role change or network/command action. Envelope look-alikes (`<<<`/`>>>`),
  control characters are neutralised. Heuristic flags (override/fake system/act-as/shell/exfiltrate/reveal/call-URL/tool/
  fake-citation) are stored per chunk and shown in the UI as a warning — flag, never authority, never silent block.
- Structural: NB-2 modules import no `child_process`, http(s)/net, cloud provider, Omega, Rassilon, Device Fabric,
  browser automation, mail — asserted by a static test on the import lines and code. Retrieval returns information +
  citations only; the only outputs of `ask` are `answer / citations / metadata`.
- Notebook → shell / OMEGA / RASSILON / Device Fabric / publication: **0** code paths.

## 9. Secret scanning

Patterns: private keys, AWS keys, GitHub tokens, API keys, JWT, Bearer, connection strings with credentials, Cookie /
Set-Cookie headers, `password=`-style assignments (reuses `logger.redactSecrets` for redaction). Scan runs on the
extracted text before chunking. Policy: default **BLOCK** (`SECURITY_BLOCKED` / `SECRET_DETECTED`, nothing indexed);
explicit user choice **REDACT** indexes `[SECRET_REDACTED]`; **private keys are always blocked** (no redact path).
Findings expose kind / count / line numbers only — never the value (tested through the API response and the UI).
Documents are `local_only` by default so the existing `privacy-guard` sentinel logic applies to any downstream use.

## 10. Citation model

`{ ref, chunkId, sourceId, documentVersion, versionId, page, headingPath, trustLevel, superseded, passage }`.
A citation exists only if `[N]` is inside the pack **and** the chunk still exists in *this* notebook at validation time.
`[99]`, `[0]`, deleted documents, other notebooks ⇒ dropped. Trust levels stored per document/chunk; text entered as
AI output is `PAST_AI_OUTPUT`, labelled in the prompt and never presented as verified.

## 11. Deletion

`removeDocument` removes: `nb_documents`, versions, chunks, FTS rows, embedding metadata, LanceDB vectors, the
`notebook_sources` row, recomputes derived privacy. Also wired into notebook delete and the existing source delete route.
In-flight imports are cancelled (AbortController): after deletion no rows and no vectors remain (tested with a gated embed).

## 12. Retention

Only **KEEP** is implemented. `SESSION_ONLY`, `DELETE_AFTER`, `MANUAL` are rejected with `INVALID_OPTION`
(not faked). `SESSION_ONLY` needs a storage-layer in-memory path ⇒ deferred to NB-3.

## 13. UI

Notebook modal ⇒ new **DOCUMENTS** tab + always-visible **STRICT LOCAL** badge; no cloud control anywhere.
Add file (TXT/MD/PDF/HTML/JSON), paste text (with "vient d'une IA" flag), status chip per document
(QUEUED → … → READY, polled only while something is importing; READY is what the backend persisted after indexing),
secret-block panel (kinds only, explicit "index with secrets masked"), delete, search (no LLM) / ask (local LLM),
citations with source, version and page, injection warning, `VECTOR_UNAVAILABLE` notice. Verified with a Playwright
harness on a fully mocked API (17 assertions).

## 14. Logging

Only sourceId, stage, duration, error code, model name. No document body, secret or vector is logged
(checked on the real server log after an import).

## 15. Network proof (Strict Local)

`test-nb2-notebook-documents.mjs` instruments `fetch`, `http(s).request/get` and `net.Socket.connect` (recording and
refusing non-loopback) while importing TXT/MD/HTML(with a script `fetch("http://evil.example")`, remote `<img>`/`<iframe>`)/
JSON/PDF, searching, asking and purging: **0 attempts total**. Ollama on loopback (`OLLAMA_URL`, default
`http://localhost:11434`) is the baseline embedding/LLM path and would be allowed; in tests it is a plain function.
Browser side: 0 fetch/XHR/WebSocket requests leave loopback. **Pre-existing finding, not changed here:** the app-wide
stylesheet loads Google Fonts (`fonts.googleapis.com`, 3 static requests) when the UI opens — unrelated to Notebook data,
but it is an external request of the frontend; worth a separate decision.

## 16. Tests

| Suite | Result |
|---|---|
| `test-nb2-notebook-documents.mjs` (new) | 37/37 — parser+security 17, retrieval 6, citations 2, versioning 2, deletion 1, retention 1, past-AI 1, limits/status 1, concurrency 1, cancellation 1, migration 1, routes 2, network proof 1 |
| `scripts/test-notebook-docs-browser.mjs` (new, mocked API) | 17/17 |
| Existing Notebook files (5) | 75/75 |
| All `test-phase*.mjs` + `test-batch-*.mjs` | 0 failures |
| `npm run build` (runs `tsc`) | PASS |
| Server boot (isolated temp DB/LanceDB, port 3911): boot → migration → import → search → notebook delete purge → shutdown | PASS; one listener only (127.0.0.1:3911, the configured port) |
| Diff secret scan | 0 non-synthetic secrets; fixtures are explicitly fake (`sk-live-FAKE…`) |

## 17. Limitations / deferred

- DOCX not implemented (no audited library). PDF: text PDFs only, no OCR; the PDF fixture is hand-built.
- Retention: KEEP only. Folder watching, AI-history imports, Gemini, Google Drive: not started (per mission).
- The vector floor (0.35) and RRF constant were validated with synthetic vectors; **not calibrated against real
  `nomic-embed-text` embeddings** (no Ollama in the test environment) — calibrate in NB-3.
- Existing `/ask`, `/summary` and NotebookLM export still operate on neuron sources only; raw documents use the new
  `doc-search` / `doc-ask` endpoints (kept separate to avoid changing certified Phase 5 behaviour).
- Secret scanning is pattern-based (no entropy scoring); injection heuristics are defense in depth — the primary
  defence is structural isolation. Language detection is a FR/EN stopword guess.
- Import status: secret scan runs after parsing (so status goes PARSING → SCANNING); the file is not copied to disk
  (`localPath` = none), only extracted text/chunks are stored (unencrypted at rest, like the rest of Docteur; OS-level disk encryption per NB-1 §28).
- `client.ts` / `App.tsx` also contain the uncommitted YouTube-Shorts changes from the previous mission.
