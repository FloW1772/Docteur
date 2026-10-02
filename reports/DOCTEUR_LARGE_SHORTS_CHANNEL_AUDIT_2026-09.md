# DOCTEUR — Large YouTube Shorts channel discovery / streaming / limits / UI audit

Date: 2026-10-01 · Mode: HIGH · Type: AUDIT ONLY (no product change, no fix) · Test URL: `https://www.youtube.com/@Ines-n9m/shorts` (public, no cookies, no login)

## 0. Verdict in one paragraph

25 / 50 / 100 work and match yt-dlp exactly. **ALL fails on a 2 500+ Shorts channel**, for several stacked reasons:

1. **TIMEOUT_BUG (primary).** In ALL mode yt-dlp (`--flat-playlist --dump-json`) prints **nothing** until it has crawled all ~86 API pages, then dumps all 2 573 lines in ≈ 2 s. That silent crawl lasted **39 s, 79 s, 123 s and 134 s** in four successive runs. Docteur's inactivity watchdog (`DEFAULT_INACTIVITY_TIMEOUT_MS = 60 000`, armed at spawn, re-armed only when a *new unique video* is parsed) fires at 60 s while yt-dlp is working normally → `TimeoutError`, whole result discarded.
2. **Process kill is incomplete on Windows.** `proc.kill()` kills the yt-dlp bootloader only; the worker survives, keeps the inherited stdout pipe open, so the `close` event (and therefore the rejection / the `error` NDJSON line) is delayed until the worker finishes (60 s watchdog → error delivered at 150.6 s in the server run; abort → promise still pending 20 s later; the worker lives 80–90 s after a client disconnect).
3. **UI gives no usable feedback and no cancel.** For a channel URL the capture modal is closed on submit (`App.tsx` ≈ 5817, `if (!isDeep) setCaptureOpen(false)`), but the progress view (“Shorts détectés : N”, spinner, *Annuler*) lives inside that modal. During the 40–150 s crawl the screen shows nothing, reopening the modal does not show the progress view, and the cancel button is unreachable. The user therefore sees “nothing happens”, then, at the end, a generic error toast.
4. Not bottlenecks: yt-dlp args, streaming parse, dedup, memory, CPU, payload, HTTP, Ollama.

Final verdict: **MULTIPLE_CAUSES** (primary TIMEOUT_BUG; user-level: LIMITED_MODES_SAFE_ALL_NOT_SAFE).

## 1. Trace UI → yt-dlp → UI

| Step | Code | Finding |
|---|---|---|
| Input | `detectChannelUrl` (App.tsx) returns the trimmed URL unchanged | `/shorts` tab preserved |
| Classification | `classifyYouTubeUrl` / `normalizeChannelVideosUrl` (lib/ytdlp.js) | `channel_shorts`, normalized URL still ends with `/shorts` (verified in `audit-shorts-docteur-results.json`) |
| Limit selector | CaptureModal `<select>` 25/50/100/Tous → `collectionLimit` | Transmitted verbatim: body `{mode:'limited',limit:25|50|100}` or `{mode:'all'}` (verified in real App, 4 options) |
| Frontend call | `startChannelCapture` → `cortexClient.getPlaylist` → `apiFetch(..., mode==='all' ? null : 40_000)` | ALL: no timeout; limited: 40 s covers only time-to-headers (route writes `started` at once) |
| Route | `POST /api/capture/playlist` (routes/capture.js) | NDJSON: `started`, `progress {count}` per entry, one `done {result}` carrying every video, or `error {name,message}`; `signal: c.req.raw.signal` |
| Spawn | `getPlaylistInfo` | structured argv, `stdio:['ignore','pipe','pipe']`, no shell |
| Parse | incremental `stdoutBuffer += d; split(/\r?\n/)`, remainder kept | line-by-line, not buffered |
| Dedup | `Set` on video id | O(n) |
| Frontend | reader + line split, resolves at `done` | incremental reader; items only available at `done` |
| After discovery | `total > 30` → confirm modal (“Continuer”) → `enqueueOrStart` → `doChannelCapture` | one neuron per Short, see §9 |

Exact argv captured (audit wrapper around `spawn`): `<url> --flat-playlist --dump-json --no-warnings --no-playlist-reverse [--playlist-end N]` — `--playlist-end` only in limited mode.

## 2. Questions A–P

| | Question | Answer |
|---|---|---|
| A | Waits for all results? | yt-dlp does (ALL); Docteur parses incrementally |
| B | stdout buffering | No: ≤ 64 KB chunks, 2 537 chunks for 4.6 MB, max line 2 024 B |
| C | JSONL parsing | Correct (CRLF/partial lines handled), per-line try/catch |
| D | Memory | Node RSS 47 MB (limited) / 50 MB (ALL); yt-dlp peak 72 MB (2 processes) |
| E | Server / frontend timeout | no HTTP timeout around discovery; frontend none (ALL) / 40 s to headers (limited); **only the 60 s inactivity watchdog bites** |
| F | Inactivity watchdog | armed at spawn, re-armed only on accepted new video, no stderr/heartbeat input → **incorrect for ALL** |
| G | Artificial limit | none (grep for MAX_ITEMS / `slice(0,100|200|500|1000)` / `AbortSignal.timeout` in ytdlp.js, capture.js, server.js, client.ts: nothing on this path) |
| H | ALL handling | `requested_limit:null, limit_reached:false, has_more:false` contract correct; no `--playlist-end` |
| I | Dedup cost | O(n), 0 duplicates found (2 573 raw = 2 573 unique) |
| J | UI waits for final response | yes for items (single `done` line); progress counts only |
| K | Thousands of cards rendered | No: discovery renders no item list; results become neurons |
| L | Premature cancel | the *watchdog* is the premature cancel (60 s) |
| M | NDJSON progress consumed | yes (`onProgress(count)` → `capturePhase`) but the phase is invisible (modal closed) |
| N | Wrong yt-dlp args | no; limited modes stop early (`--playlist-end`) |
| O | Heavy post-discovery | yes, see §9 (not the cause of the failure, but of a very long ALL import) |
| P | Ollama on critical path | **No**: server booted with `OLLAMA_URL=http://127.0.0.1:9` (health `ollama_connected:false`); 25/50/100 discovery returned normally |

## 3. Real measurements (all public, metadata only)

### 3.1 Direct yt-dlp (Docteur's exact argv)

| Mode | lines | first line | done | notes |
|---|---|---|---|---|
| 25 | 25 | 1 632 ms | 2 041 ms | |
| 50 | 50 | 1 528 ms | 1 934 ms | |
| 100 | 100 | 1 993 ms | 2 794 ms | ~1.77 KB/line |
| ALL | **2 573** (= reported playlist_count 2573, unique 2573, dup 0) | **39 154 ms** | 41 357 ms | 4 600 169 B, stderr empty, exit 0 |

ALL milestones: 1st 39 154 · 100th 39 213 · 500th 39 473 · 1000th 39 777 · 2000th 40 641 · 2500th 40 931 · last 41 357 ms. The whole burst takes 2.2 s; the 39 s before it is a silent crawl (`-v` shows “page N: Downloading API JSON” every 1.4–1.7 s; without `-v` stderr stays empty). Limited outputs are prefixes of ALL (same order). yt-dlp working set peak 72 MB.

### 3.2 ALL crawl variance (the heart of the problem)

| Run | Path | First data after spawn |
|---|---|---|
| 1 | direct yt-dlp | 39.2 s |
| 2 | Docteur module (`getPlaylistInfo`) | 79.4 s |
| 3 | Docteur, watchdog forced to 6 s, run to completion | ≈ 123 s |
| 4 | real server route | 134.5 s |

The 60 s watchdog passes only in the fastest run; the trend suggests YouTube throttling after repeated crawls. Time scales with channel size (~86 pages × 1.4–1.7 s at best).

### 3.3 Docteur `getPlaylistInfo` (module level) — parity

| MODE | yt-dlp direct | Docteur | Diff | Runtime | First result | Node RSS |
|---|---|---|---|---|---|---|
| 25 | 25 | 25 (limit_reached true, has_more null, requested_limit 25) | 0 | 1 874 ms | 1 448 ms | 47 MB |
| 50 | 50 | 50 | 0 | 2 119 ms | 1 676 ms | 47 MB |
| 100 | 100 | 100 | 0 | 2 385 ms | 1 948 ms | 47 MB |
| ALL | 2 573 | **0 – TimeoutError** (parsed 2 573 progress events after the kill) | **−2 573** | 81.5 s | 79.4 s | 50 MB, CPU ≈ 250 ms |

### 3.4 Real server route (isolated temp SQLite/LanceDB, port 3945, Ollama unreachable)

| Mode | first progress | `done` arrival | `done` line | client parse | contract | URLs |
|---|---|---|---|---|---|---|
| 25 | 5 523 ms | 6 256 ms | 6.9 KB | 0.3 ms | limit_reached true, has_more null | all `/shorts/` |
| 50 | 6 452 ms | 7 397 ms | 13.5 KB | 0.2 ms | same | all `/shorts/` |
| 100 | 8 559 ms | 9 693 ms | 27 KB | 0.9 ms | same | all `/shorts/` |
| ALL | **134 488 ms** (all 2 573 progress events within 16 s) | **never** | – | – | `error` event `TimeoutError` at **150 561 ms** | – |

(Limited latencies were 3–5× slower than the direct run of the same minute: YouTube-side variance; Docteur overhead measured at module level is ≈ 0.4 s.) First attempt of the 50/100/disconnect volets had keep-alive socket resets from the audit client (fixed with `Connection: close`; not a product issue). ALL via the route: HTTP stream open and healthy (status 200, `started` at 181 ms) — transport is not the bottleneck; payload would be ≈ 300 B/video after field reduction (raw 4.6 MB → ≈ 0.8 MB).

### 3.5 Cancellation / orphan (Windows)

| Scenario | Result |
|---|---|
| AbortSignal at 8.7 s of ALL (UI cancel / HTTP disconnect) | 2 yt-dlp processes before, **1 survives** (worker); promise **still pending 20 s after abort** (`close` waits for the surviving worker's pipe) |
| Watchdog kill (forced 6 s) | 1 process at 9 s; TimeoutError only at 123 s, **after** the worker finished and streamed all 2 573 lines |
| Real route, client disconnect at 12 s | 2 processes during, **1 process still alive 80 s later**, 0 at 90 s (worker finished the whole crawl by itself) → no persistent zombie, but a wasted crawl + pipe held for the crawl duration |
| Limited 25 | clean exit, 0 processes after |
| Product comparison | other code (video-audio-download) already uses `taskkill /T /F`; discovery uses plain `proc.kill()` |

Cancel cross-talk: static analysis only — `startChannelCapture` does `deepAbortRef.current?.abort()` on a ref shared with deep capture / analysis / whisper (App.tsx 3349, 3412, 3770): starting channel discovery can abort another job using that ref. Not exercised end-to-end (NOT_PROVEN). Article capture / 20 Minutes / Notebook not touched.

## 4. Frontend (real `src/App.tsx`, mocked network, synthetic replay of the exact NDJSON shape)

- Limit selection 25/50/100/ALL transmitted correctly.
- `done` of 2 573 items consumed and confirm dialog (“Cette opération va créer 2573 vidéos de la chaîne (~5 min). 515 lots”) displayed ≈ 0.7 s later than for 50 items (parse/render of the big `done` line: negligible). No false “0 Shorts” (check fixed after a false positive on “50 Shorts”).
- Error visibility: `TimeoutError` → toast “Erreur / timeout pendant la recherche de Shorts”; any other error → “Impossible de récupérer les infos de la chaîne” (cause not shown). Cancel path toast exists in code (`Recherche de Shorts annulée`) but cannot be triggered: the cancel button is not reachable (modal closed).
- **UI silence**: the phase text “Recherche en cours… Chargement de Shorts supplémentaires…” flashes once, then the modal closes (`modal-box` count 0, spinner 0, cancel 0 at t = 1.5 s); reopening *Capturer* shows the normal modal, not the progress view.
- Thumbnails: **0** `i.ytimg.com` requests during discovery and during 95 s of import (thumbnail URL stored in metadata only) → no request storm in this harness. Not proven for a real GPU build once neurons are displayed.
- Rendering/long tasks: the headless 3D scene alone saturates the main thread (idle: 38 long tasks / 19.2 s in 20 s). The import phase showed the same rate (163 long tasks / 95 s), JS heap 23 → 49 MB, max long task 0.96 s. Import throughput in the harness: 1.16 items/s → ~37 min projected for 2 573 (mock index 50 ms; confounded by software rendering). Lower bound from code: 2 573 × 80 ms pause ≈ 3.4 min plus 3 s-debounced serial embeddings (Ollama) per neuron. **UI render bottleneck: NOT_PROVEN**; memory is not an issue.
- Virtualization: no list of discovered items exists; nothing to virtualize in discovery.
- Queue relation: discovery is **outside** the batch queue (`enqueueOrStart` covers only `doChannelCapture`); a second submission while `captureBusy` is ignored (no replace/race), but `startChannelCapture` replaces the shared `deepAbortRef`.

## 5. Stall classification

| Class | Verdict |
|---|---|
| YT_DLP_STALL | **Yes (legitimate)**: silent 39–134 s crawl before first byte in ALL |
| SERVER_PARSE_STALL | No (2 573 lines in < 3 s, 250 ms CPU) |
| SERVER_BUFFER_STALL | No |
| HTTP_STREAM_STALL | No |
| FRONTEND_PARSE_STALL | No (0.2–0.9 ms for ≤ 100 items; ≈ +0.7 s for 2 573) |
| UI_RENDER_STALL | Not proven; UI *feedback* absent |
| POST_DISCOVERY_STALL | Likely long ALL import (3.4 min floor, tens of minutes with embeddings) — separate from the failure |
| **TIMEOUT** | **Yes: 60 s inactivity watchdog + incomplete kill** |

## 6. Security / safety

argv structured, no shell, URL passed as a single argument; no cookies/login/profile; public metadata only; yt-dlp stderr empty; no secrets captured. Audit scripts spawn only `yt-dlp` metadata calls and kill their own leftovers.

## 7. Existing tests rerun (unmodified)

`test-youtube-shorts-discovery` 24/24 · `test-checkytdlp-handling` 3/3 · `test-video-audio` 14/14 · `test-video-pipeline` 2/2 with `--experimental-test-module-mocks` (without the flag: `mock.module is not a function`, a Node-flag environment issue unrelated to this work) → **43/43**. Note: the existing unit tests use fakes with immediate output and therefore never cover the “silent for > 60 s” case.

## 8. Recommended minimal fix (NOT implemented)

1. Watchdog: do not count silence before the first entry in ALL mode as inactivity — use a long (size-agnostic) pre-first-entry limit or feed the watchdog from yt-dlp stderr (`-v` emits one line per page; or `--print`/`--progress` equivalents) and keep 60 s only *between* entries.
2. Kill the whole tree on abort/timeout (`taskkill /PID <pid> /T /F` on win32, as video-audio-download already does) so `close` fires immediately and no worker continues.
3. Keep the progress view visible for channel discovery (do not close the modal, or show a persistent banner with a cancel button) and show elapsed time; distinguish timeout / cancel / yt-dlp error in the toast.
4. Optional: stream items in batches rather than one `done` line; guard the shared `deepAbortRef`; plan the 2 573-neuron import as a chunked/background job.

## 9. Files created by this audit (no product file touched)

`cortex-server/audit-shorts-direct.mjs`, `audit-shorts-docteur.mjs`, `audit-shorts-cancel.mjs`, `audit-shorts-server.mjs`, `scripts/audit-shorts-frontend.mjs`, `reports/audit-shorts-{direct,direct-limited,docteur,cancel,server,frontend}-results.json`, scratch `.tmp/stderr-probe.mjs`, `.tmp/fe-cancel.mjs`, `.tmp/server-*.log`. Freeze manifest `node cortex-server/nb7-freeze-manifest.mjs --verify` → drift `[]`. All pre-existing `M` files in `git status` come from earlier missions.
