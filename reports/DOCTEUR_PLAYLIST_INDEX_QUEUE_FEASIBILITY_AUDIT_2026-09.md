# DOCTEUR — Playlist / indexing queue feasibility audit

Date: 2026-09-30 · **AUDIT ONLY**: no product file was modified, nothing installed, no dependency added, no behaviour changed, no queue implemented
(`git status --short` still lists exactly the pre-existing modified files; `git diff --name-only` contains no OMEGA / RASSILON / Device Fabric / Maître / Observateur path).
Only new audit artifacts were created (§12). Git: only `status --short`, `diff --stat`, `diff --name-only`.

## 0. Answer

> **Can I launch several playlists without waiting and be sure they index one after the other?**  →  **PARTIAL — WORKS BUT NOT GUARANTEED.**

The frontend has a real, ordered (FIFO) queue and it worked as designed in every controlled test — **but it lives in React state only**, is bypassed in several
situations, and « job finished » does **not** mean « indexed ». Main question (§1 A–E): the truthful classification is **D — it depends on the capture type**, with
**A (one active job, others really queued)** for the normal playlist / channel / multi-URL / deep-analysis path and **B (parallel)** for a start-window race and for
un-queued entry points; **E (no guarantee)** applies to the server, which has no queue at all.

## 1. Classification (proved by code **and** by tests)

| Case | Behaviour | Evidence |
|---|---|---|
| A — one active job, next ones queued | **Yes** for jobs started through `enqueueOrStart` (playlist import, channel/Shorts, multi-URL capture, « seule » playlists, deep analysis) | S1: A→B→C strictly sequential, FIFO, toasts « Ajouté à la file (position 2/3) » |
| B — parallel | **Yes** when a job is accepted while `batchProgress` is still `null` (first async step of a playlist import = creating the playlist neuron; the « seule » single-playlist path never sets progress); un-queued paths (single capture, Whisper single, discovery) | S2: B started while A was held, `babababababababa` interleaved saves, no « queued » toast |
| C — a new task replaces/cancels the previous | **Only** for `startChannelCapture` (channel/Shorts discovery): `deepAbortRef.current?.abort()` (App.tsx:3295) aborts whatever holds the shared controller — a running deep-analysis batch | code-proven (not run in browser) |
| D — depends on the capture type | **Yes** (table §3) | — |
| E — no guarantee | **Server side**: no queue, no limiter, no ownership | §4, §7 |

## 2. End-to-end flow and sync / async classification

| Step | Where | Nature |
|---|---|---|
| URL entered → `captureFromInput` | App.tsx:3629 | sync gate: `if (!value \|\| captureBusy) return` (silently ignored while a deep-capture batch/discovery is busy) |
| Playlist discovery | `POST /api/capture/playlist` (capture.js:227) → `getPlaylistInfo` → `spawn yt-dlp --flat-playlist` | **request-scoped, streamed NDJSON** (`started/progress/done/error`), own `AbortSignal` per request, **not queued**, unbounded parallel |
| Modal / confirm | `playlistImport` (single slot) → `handlePlaylistConfirm` (App.tsx:4438) | UI-serial (one modal at a time) |
| Job start | `enqueueOrStart(label, count, run)` (App.tsx:2809) | **THE point where a playlist becomes a task** |
| Video enumeration → neurons | `runBatch` loop: `createPageFromData` (local IndexedDB **then** `PUT /api/neuron/:id`, SQLite) per video | sequential in a job; `flushIndex()` at lot boundaries (`batchSize` 5) |
| Download / transcription | **not part of a playlist import** (videos are created `light: true`, metadata only). Only « Analyse en profondeur » (`runDeepBatch`) → `POST /api/capture/deep` (90 s) → `needs_whisper` → `POST /api/capture/whisper` (SSE: yt-dlp audio → ffmpeg → faster-whisper/Groq → routed LLM analysis) | sequential per video inside a job, 500 ms gap |
| Metadata | inside the neuron (`metadata.url/youtubeId/playlistId`) | sync with creation |
| Chunking | none for neurons (one embedding per neuron, `MAX_EMBED_CHARS` truncation) | — |
| Embeddings / indexation | `cortex.scheduleIndex(page)` (useCortex.ts:130): **3 s per-page debounce timer → serial promise chain (`indexChain`) + 300 ms gap → `POST /api/index`** → Ollama embed → LanceDB `mergeInsert` | **fire-and-forget** (the batch never awaits individual embeddings); `flushIndex()` awaits the chain **as it is at call time** (pages still in their 3 s timer are not in it) |
| Persistence | SQLite (`savePageToStoreIfNewer`, last-writer by `updatedAt`), LanceDB (`neurons`), IndexedDB copy | — |
| Progress mirror | `POST/PUT/DELETE /api/jobs` (routes/jobs.js) — a **passive in-memory progress registry**, not a scheduler | debounced 2 s |

**« Request finished » ≠ « indexing finished »**: `/api/capture/playlist` returns after *discovery only*; the batch « done » toast appears after neuron creation; embeddings
happen later (debounce + serial chain). Measured (S1): the job was reported done **before** its last video was embedded for A and B.

## 3. Entry points (per capture type)

| Entry | Queued? | Notes |
|---|---|---|
| Pure playlist URL → import | yes (`enqueueOrStart`) after an un-queued discovery + confirm modal | start-window race (S2) |
| « seule » + several playlist URLs | one queued job, playlists processed sequentially inside (600 ms gap) | a **single** « seule » playlist never sets `batchProgress` ⇒ not seen as active |
| Channel / Shorts URL | discovery **not** queued and it **aborts the shared `deepAbortRef`**; the capture job is queued | case C |
| Several article/video URLs | queued (`startDeepCaptureBatch`), sets `captureBusy` ⇒ further captures ignored | cancel only honoured at lot boundaries |
| Deep analysis of light neurons | queued (`runDeepBatch`) | in-flight fetch not aborted by the Cancel button (only `batchAbortRef`) |
| Single URL / single Whisper / pasted text | **not queued**, direct, own controllers (`deepAbortRef` / `whisperAbortRef` — shared, last writer wins) | — |
| Server routes (`/capture/*`, `/index`) | **no queue, no limiter** | any client can run them concurrently |

## 4. Existing queue: real or not?

Grep for `queue / pending / activeJob / semaphore / mutex / p-limit / Promise.all / worker / scheduler / FIFO`:

* **Real queue, frontend only, memory only**: `batchQueue` (React state + `batchQueueRef`), max 10 (`File pleine`), FIFO, drained by `runNextInQueue()` (150 ms timer) at the end of each runner. UI: queue list with positions, remove, « Tout annuler », pill badge.
* **Real serial index chain**: `indexChain` in `useCortex.ts` (« Semaphore… only one embedding runs at a time ») — global to the page, ordered by debounce-timer firing time.
* Server: **no queue**. `jobs.js` is a progress map. Only precedents: connectors `activeSyncs` (409 per provider), metagpt `hasActiveJobs()` (409), `_powerfulBusy` (14 b model). None applies to capture / index.
* Persistent job tables exist **elsewhere** (`video_jobs`, `rassilon_jobs`, `rassilon_remote_jobs`) — unrelated to playlists.

## 5. Multi-request, concurrency, ordering (measured)

Method: the **real `src/App.tsx`** mounted in Chromium with a mocked network and « gates » that hold one request until released (so timing never decides), plus a **real cortex-server** (temp DB, port 3944) with real yt-dlp (metadata only) and real Ollama.

| # | Scenario (browser, real frontend queue) | Observation |
|---|---|---|
| S1 | A (held on its last save), B and C confirmed meanwhile | A → B → C strictly sequential (save windows disjoint), FIFO index order `aaaaaabbbbbbcccccc`, max **1** `/api/index` in flight, toasts « position 2/3 ». **Discovery of B and C ran while A was active (not queued).** Job reported done **before** its last embedding (A, B). |
| S2 | A's first async step (playlist-neuron save) held while B is confirmed | **B not queued, ran immediately, in parallel**: interleaved saves `bababa…`; both loops share `batchAbortRef`, `batchProgress`, one `jobIdRef` ⇒ one server job entry orphaned « running » forever |
| S3 | Cancel A (running) with B, C queued | A stopped after the in-flight item (4/8), **B and C ran to completion** (cancel isolation OK). Duplicate `startJob` registrations observed (orphan « running » job) |
| S4 | one video save returns 500 — local (PC) mode | A finishes, B runs (isolation OK) **but** the page stays in IndexedDB only and is **still embedded into LanceDB** (vector row without SQLite neuron) |
| S4b | same failure — remote (LAN/phone) mode (`requireServer`) | `createPageFromData` throws, **no try/finally**: job A never ends, progress never clears, queued B **never starts** (stuck until reload) |
| S5 | same video in A (last) and B (first) | B confirmed while A's item pending ⇒ **two neurons, two embeddings** for one video URL |
| S6 | same playlist imported twice, same session | 3 neurons, 1 playlist neuron: idempotent |
| S7 | reload mid-job with B queued | A interrupted (partial), **B silently lost**, ghost pill « interrompu — 1/6 » restored from the registry (it displayed 1/6 although 4 were created: progress is mirrored every 2 s); pending 3 s index timers lost |
| S8 | one embedding fails (503) while server « available » | attempted once, **never retried** (offline queue drains only on an unavailable→available transition); playlist reported « importée » |
| S9 | re-import after a restart when the playlist's neurons are older than the 50 loaded stubs | **second playlist neuron + 3 duplicate videos** (dedup only sees loaded pages) |

Concurrency limits (from code + measurements):

| Resource | Bound |
|---|---|
| Active playlist jobs | 1 in the queue path; 2+ in the S2 race and with un-queued flows |
| Discovery | **unbounded parallel** (real test: 2 playlists ⇒ up to 4 `yt-dlp.exe` processes at once; 5 playlists ≈ 10) |
| Videos in a job | 1 at a time |
| `/api/index` from the UI | 1 at a time (serial chain); **from several tabs / devices / re-index: unbounded** |
| Ollama embeddings | server does not limit; measured 7 parallel requests accepted with 0 error, per-request latency ×4–5 (queuing inside Ollama), total time ≈ serial — no gain, no proof of VRAM safety |
| yt-dlp / ffmpeg / python-whisper for deep analysis | 1 per running deep batch; **no server-side cap** (a second parallel batch or client doubles it; `whisper.js` itself says « caller must ensure Ollama is NOT running a request simultaneously ») |

## 6. State, ids, globals, cancellation

* **Shared mutable state** (module/ref singletons in `App.tsx`): `batchAbortRef` (one boolean for every runner), `deepAbortRef` (one controller shared by single capture, batch capture, deep analysis **and** channel discovery), `whisperAbortRef`, `jobIdRef`, `batchProgress`/`batchProgressRef`, `batchParentsRef`, `queueSessionRef`. `ghostBatchRef` makes `enqueueOrStart` start immediately.
* **Ids**: no `jobId/batchId` per playlist; the queue items have an internal `generateId()`; the server job id is a single `jobIdRef` (duplicates and orphan « running » entries observed — `purge()` never removes `running` jobs, so `hasActiveJobs()` can stay true forever).
* **States**: no QUEUED/DISCOVERING/DOWNLOADING/PROCESSING/INDEXING/READY/FAILED/CANCELLED. Reality: `batchProgress {operation,current,total,currentLabel,okCount,fallbackCount,errorCount}` while running, a toast at the end; queued jobs are only `{label,count,run}`.
* **Cancellation**: the button is « Annuler après ce lot » → `batchAbortRef=true` only. Import/channel loops check it every item; `startDeepCaptureBatch` only at lot boundaries; `runDeepBatch` lets the in-flight download/transcription finish. Cancelling A does not cancel B (S3); « Tout annuler » clears the queue. Case C above (channel discovery aborts a running deep batch) is the one cross-cancel.
* **Skipped counted as errors** in the import progress (`errorCount: skipCount`).

## 7. Server, database, temp files, Ollama

| Item | Result |
|---|---|
| SQLite | **PASS**: `better-sqlite3` is synchronous; `savePageToStoreIfNewer` is last-writer by `updatedAt` with no `await` between read and write (atomic in one event loop turn). Risks are logical (mixed ownership when the PUT fails and the page lives only in IndexedDB), not corruption. |
| LanceDB | **FAIL (measured, real server)**: (a) first-insert race on an empty table — 4 of 6 concurrent `/api/index` returned **HTTP 500** « createTable failed: Table 'neurons' already exists » (the frontend then queues them offline, never drained while the server is up) ; (b) 3 concurrent writes of the **same id** produced **2 rows** for that id (`mergeInsert` is not atomic across concurrent commits) ; (c) distinct ids concurrently: no loss (16/16). |
| Temp files | **No collision**: whisper audio `whisper_<ts>_<random>` / `wgroq_<ts>_<random>` (unique, cleaned in `finally`, `data/tmp` wiped at boot only), audio downloader has `jobId`. Minor: `routes/download.js` names its subtitle dir `docteur-subs-${Date.now()}` (ms resolution) and takes `files[0]` — two requests in the same millisecond would share it. |
| Ollama | Not serialised by the server; the UI serialises (chain + 300 ms). Concurrent calls are accepted (measured) but latency multiplies; VRAM/GPU contention **not measured** (UNKNOWN). Deep analysis relies on caller discipline for Whisper-vs-Ollama VRAM. |
| Duplicates | dedup only in the frontend, by `metadata.url` **or** normalised title, only against **loaded** pages (50 most recent stubs + this session's); no videoId, no content hash, nothing server-side ⇒ double neuron and double embedding (S5, S9); a « downloaded twice » case cannot occur for playlist import (no download), but deep analysis would run twice on the duplicates. |
| Restart | frontend queue and index timers lost; server job registry lost (measured: registered job gone after restart); a running batch is not resumed and leaves a partial playlist (neurons created so far persist; links are saved at the end, `repair-links` exists as a manual fix); unindexed pages are recoverable only through the manual « Réindexer » |
| Persistent queue | **none** (memory only) |

## 8. Completeness / partial states

`runBatch` ends with `flushIndex()` (awaits the chain snapshot) but the last videos are still inside their 3 s debounce ⇒ « playlist importée » is shown before they are embedded; no FTS for neurons; nothing records « fully embedded »; no `READY_WITH_ERRORS` — deep analysis reports « N analysées · M erreurs » and a failure modal (`batchFailures`); import reports created/existing counts only; embedding failures are silent (S8).

## 9. Resource pressure with 5 playlists launched quickly

Discovery: up to 5 parallel `--flat-playlist` runs (≈ 10 `yt-dlp.exe`, network + CPU bursts, YouTube rate-limit exposure; modes « Tous » have only a 60 s inactivity watchdog). Imports themselves are light (metadata, no download) and queued (max 10). RAM/disk: negligible. Ollama: serial from the UI, so 1 embedding at a time. The dangerous combination is **deep analysis** (yt-dlp audio + ffmpeg + faster-whisper VRAM + routed LLM): protected only by queueing and by the user not starting a parallel batch (S2-type race, second tab, phone) — **no server cap**.

## 10. UI

The UI does allow launching a second playlist while the first runs: the batch modal is blocking, so the user must press **Réduire** (pill in the top bar with a queue badge), then paste the next URL. It shows position (« Ajouté à la file (position N) »), the queue list (positions, remove, cancel all) and progress; it does **not** show QUEUED/INDEXING/READY states, does not warn that queued work is lost on reload, and gives the impression that everything is accepted although only the frontend holds it.

## 11. Frozen modules and a future queue

A queue can be added without touching OMEGA, RASSILON, Device Fabric, Maître or Observateur: the code involved is `App.tsx` (runners), `useCortex.ts`, `routes/capture.js`, `routes/jobs.js`, `server.js` wiring and `lancedb.js` — none imports them; RASSILON's own job queue (`maxConcurrentJobs`) is separate and should not be reused.

## 12. Tests run

* **Audit browser suite** (real App, mocked network): 11 scenarios — S1 S2 S3 S4 S4b S5 S6 S7 S8 S9 (+ toast/queue observations). Results: `reports/audit-playlist-queue-browser-results.json`. A harness-level page error `outputs is not iterable` appears in every run (a mocked-API artefact, unrelated to the queue).
* **Audit server test (real yt-dlp metadata + real Ollama + real LanceDB)**: `reports/audit-playlist-queue-server-results.json` — parallel discovery (2 public playlists, 7 and 25 videos, isolated results, up to 4 `yt-dlp.exe`), abort isolation (aborting A's HTTP request did not affect B), serial vs parallel index, first-insert race, same-id race, job-registry restart.
* Existing relevant suites: `test-youtube-shorts-discovery` 24/24, `test-checkytdlp-handling` 3/3, `test-video-audio` 14/14, `test-jobs-route` 5/5, `test-neurons-all-meta` 2/2, `test-agent-neuron-lifecycle` 1/1, `test-batch-a-robustness` 12/12, `test-batch-b-notebook-performance` 5/5, `test-phase5-notebook` 17/17, `test-batch-d-connectors` 33/33 = **116/116**. `test-video-pipeline` and `test-video-manual` (Video Studio, not the playlist path) fail here for environment reasons (`mock.module` needs `--experimental-test-module-mocks`; a cwd-dependent `mkdtemp` path) — unrelated to this audit and unchanged by it.
* **NOT_RUN**: a real two-playlist run through the real UI against the real server (would need the app on an allowed CORS origin and real playlists; the equivalent behaviours were proven with the real App on a mocked network and the real server on real playlists separately); real Whisper/ffmpeg/VRAM pressure (no large media downloaded, by instruction); Ollama VRAM contention; channel-discovery-aborts-deep-batch in the browser (code-proven only).

New files (audit artefacts only): `scripts/audit-queue-harness.jsx`, `scripts/audit-queue-lib.mjs`, `scripts/test-audit-playlist-queue-browser.mjs`, `cortex-server/audit-playlist-queue-server.mjs`, the two `reports/audit-playlist-queue-*-results.json`, this report.

## 13. Recommendation (NOT implemented)

Minimum architecture to make « launch several playlists, they index one after the other » a guarantee:

1. **Server-side persistent FIFO** (`ingest_jobs` table in SQLite: `jobId, kind, url, options, state, createdAt, startedAt, finishedAt, error`), one **active ingest worker**, states `QUEUED → DISCOVERING → IMPORTING → INDEXING → READY | READY_WITH_ERRORS | FAILED | CANCELLED`, single position counter, `POST /api/ingest/jobs`, `GET …`, `DELETE …/cancel`; the frontend only submits and displays.
2. **Per-job `AbortController`** (server) and per-job ids everywhere; remove `batchAbortRef`/`deepAbortRef` sharing.
3. **Indexing inside the job**: the job is READY only when every item has SQLite row + vector (verify by id), with **bounded retry** (backoff) and per-item failure isolation (`try/finally` around each item, failed item ⇒ `READY_WITH_ERRORS`).
4. **Idempotence**: dedup by `youtubeId`/canonical URL on the server (unique index), not by title on loaded pages.
5. **LanceDB writes through one serial writer** (promise chain in `lancedb.js`) — fixes the first-insert race and same-id duplicates regardless of the queue.
6. **Restart recovery**: on boot, jobs `DISCOVERING/IMPORTING/INDEXING` → re-queued from their last committed item or marked `FAILED(interrupted)`; a boot sweep re-indexes neurons lacking a vector.
7. **Resource caps**: one discovery at a time (or 2), one Whisper/Ollama heavy stage at a time.
8. UI: show state + position, warn if the browser holds unsent work; keep the existing pill/queue list as a view of the server queue.

Cheaper interim mitigations (each small, none implemented here): guard `enqueueOrStart` with a synchronous `runningRef` set before `run()`; wrap runners in `try/finally { setBatchProgress(null); runNextInQueue() }`; serialise `upsertNeuron`; await the debounce inside `flushIndex`.

## 14. Checkpoint summary

Queue exists: YES (frontend, memory-only) · one active playlist guaranteed: **NO** · order: FIFO when queued · second playlist during first: QUEUED (PARALLEL in the start-window race) · LanceDB concurrency: **FAIL** · duplicate video handling: **FAIL** · failure isolation: **FAIL** (remote-mode stall) · restart recovery: NOT_IMPLEMENTED · playlist completion = full indexing: **NO** · safe to launch back-to-back: **PARTIAL — NOT GUARANTEED**.
