# DOCTEUR — YouTube Smart Channel Discovery V2

Date: 2026-10-01 · Mode HIGH · Implementation + real harness + regressions. Public content only (yt-dlp metadata, no cookies, no login, no download, no auto-update).

## 1. Root cause (from the audit `DOCTEUR_LARGE_SHORTS_CHANNEL_AUDIT_2026-09.md`)

| # | Cause | V2 fix |
|---|---|---|
| 1 | 60 s inactivity watchdog armed at spawn, re-armed only on a new unique entry; yt-dlp ALL is silent 39–134 s | heartbeat watchdog (stderr/stdout activity) + separate max-runtime guard |
| 2 | `proc.kill()` on Windows kills the yt-dlp bootloader only; the worker runs on and holds the pipe (abort pending, error delayed 90 s) | `taskkill /PID <pid> /T /F` tree kill + settle guard |
| 3 | Capture modal closes on submit → progress and *Annuler* invisible | persistent `YouTubeDiscoveryPanel` outside the modal |
| 4 | one giant `done` line, count-only progress | typed NDJSON events, `items_batch` per finished phase |
| 5 | manual 25/50/100/Tous selector; shared `deepAbortRef` | selector removed (mode comes from the URL); dedicated `ytDiscoveryAbortRef` |

## 2. Design

### 2.1 URL classifier — `cortex-server/src/lib/youtube-discovery.js` (`classifyDiscoveryInput`)

The URL keeps its intent: no `/shorts → /videos`, `/videos → /shorts`, `/streams → /videos`, no tab → root rewrite. The canonical URL is rebuilt from the validated handle/channel id (query/fragment dropped, never concatenated into a shell).

| Input | Mode | Sources (yt-dlp `--flat-playlist` URL) |
|---|---|---|
| `https://www.youtube.com/@h`, `/@h/`, `youtube.com/@h`, `?si=…`, `/featured`, `/about`, `/channel/UC…`, `/c/x`, `/user/x` | `CHANNEL_ALL_MEDIA` | `/videos`, `/shorts`, `/streams` (sequential, in that order) |
| `…/@h/videos` | `CHANNEL_VIDEOS_ONLY` | `/videos` |
| `…/@h/shorts` | `CHANNEL_SHORTS_ONLY` | `/shorts` |
| `…/@h/streams` | `CHANNEL_STREAMS_ONLY` | `/streams` |
| `…/@h/live` | `CHANNEL_LIVE` | none — a live is a specific stream, never expanded to a channel listing (route answers `UNSUPPORTED_MODE`; the UI does not treat it as discovery) |
| `youtube.com/playlist?list=…` | `PLAYLIST_ONLY` | the playlist |
| `watch?v=`, `youtu.be/`, `/live/<id>`, `/embed/<id>` | `SINGLE_VIDEO` | none (no spawn) |
| `/shorts/<id>` | `SINGLE_SHORT` | none (no spawn) |
| `…/@h/playlists`, `/community`, other tabs, foreign hosts, malformed, > 2 048 chars, whitespace/control chars | rejected (`unsupported_tab`, `not_youtube`, …) | — |
| bare `@h`, `/@h`, `@h/shorts` | accepted **only** with `context:'youtube'` (UI: explicit prefix `yt @h`, `youtube @h`, `chaine @h`) → same modes as above | — |

Unicode handles (`@テスト`, percent-encoded) are kept.

### 2.2 Items, dedup, order
Each item: `id, title, url, thumbnail?, channel?, duration?, uploadDate?, timestamp?, sourceChannel, sourceTab (videos|shorts|streams|playlist), mediaType (VIDEO|SHORT|STREAM), sourceTabs?`. URL form follows the type (`/shorts/<id>` for Shorts, `watch?v=<id>` otherwise).
Dedup: a single `Map` keyed by videoId (O(n); 60 000 entries with 50 % duplicates run in < 8 s in the unit test, practical cost ≈ ms). A video present in several tabs yields one item with `sourceTabs`; the more specific type wins (SHORT/STREAM over VIDEO); updates for already-streamed items are delivered in `done.merged`.
Order: explicit tab = yt-dlp order. Root = category order (videos, shorts, streams), each in yt-dlp order. Dates are **not** used: `--flat-playlist` rarely carries reliable upload dates, so no date is invented.

### 2.3 Watchdog (replaces the 60 s rule)
yt-dlp is spawned with `-v` (+ `--flat-playlist --dump-json --no-warnings --no-playlist-reverse`, no limit flag): the crawl then prints one stderr line per API page ("page N: Downloading API JSON"), which is the heartbeat of the otherwise silent crawl and also yields "page N" progress.
* **Stall** (`DISCOVERY_STALLED`): no stdout *and* no stderr byte for 90 s (`DOCTEUR_YTDLP_STALL_MS`).
* **Max runtime** (`DISCOVERY_MAX_RUNTIME`): 30 min per source (`DOCTEUR_YTDLP_MAX_RUNTIME_MS`) — separate guard, far above the 22–134 s observed for 2 573 Shorts.
* Real heartbeat gap measured: max 0.7–3.9 s between yt-dlp bytes, including the 2 573-Short crawl.
* Distinct user messages: Timeout vs yt-dlp error vs cancelled.

### 2.4 Windows process-tree kill — `lib/process-tree.js`
`killProcessTree(proc)`: win32 → `System32\taskkill.exe /PID <pid> /T /F` (structured argv, `shell:false`, `windowsHide`, PID taken from the ChildProcess Docteur spawned); fallback `proc.kill()`; non-Windows → `proc.kill()`. Used by the V2 engine and (minimal fix) by the legacy `getPlaylistInfo`. A settle guard (`killSettleMs`, 5 s) destroys the pipes so a surviving process can never leave the promise pending.

### 2.5 NDJSON events (`POST /api/capture/discover`, body `{input, context?:'youtube'}`)
`start`, `mode`, `phase_start`, `progress {tab,pages,count,total,elapsedMs}`, `items_batch {tab,items≤100,total}`, `phase_done {tab,count,available,pages,durationMs}`, `done {total,counts,duplicates,durationMs,channel,merged}`, `cancelled`, `error {name,code,message}`. Batches of 100 are a technical event size, not a user limit. A tab that does not exist ("This channel does not have a streams tab") is `phase_done.available=false`, not an error. Client disconnect aborts the discovery and kills the tree. Local protections unchanged (cross-origin guard still answers 403; body caps; loopback).
Legacy `POST /api/capture/playlist` / `getPlaylistInfo` / `normalizeDiscoveryOptions` remain for compatibility (and their 24 existing tests) but nothing in the UI calls them.

### 2.6 Frontend
* `src/lib/youtube/discovery-input.ts` — `detectYouTubeDiscoveryInput` (channel URL or prefixed handle; everything else → null → unchanged generic capture). `chaine <url>` still works.
* `src/lib/youtube/discovery-view.ts` — pure view-model; events are folded into a plain object and flushed to React at ≤ 4 Hz (no `setState` per item; 2 573 items → 12 DOM mutation callbacks).
* `src/components/panels/YouTubeDiscoveryPanel.tsx` — persistent panel: detected channel (`Chaîne YouTube détectée : @h`), mode (`Tous les médias`…), state (`Analyse de l’URL…`, `Chaîne détectée`, `Recherche vidéos/Shorts/streams…`, `Finalisation…`, `Terminé`, `Annulé`, `Timeout`, `Erreur yt-dlp`), per-type counts (`Vidéos : 823 trouvées`… + `Total unique`), elapsed time, page counter, **Annuler** until DONE/ERROR/CANCELLED/TIMEOUT, then **Fermer**. Explicit tab → only that row.
* `App.tsx`: `collectionLimit` state, props and the `<select>` removed (replaced by a read-only hint "mode automatique : …"); `startYouTubeDiscovery` with its own `AbortController` (never `deepAbortRef`); a second discovery while one runs → toast; `discoverYouTube` client has no timeout/limit parameters; playlist callers (`getPlaylist`) now go through the same route and are no longer silently capped at 100.
* After discovery the unchanged `doChannelCapture` import runs (confirm if > 30, queue, sequential items). Item metadata now carries `mediaType, sourceTab, sourceTabs, sourceChannel`, channel page `discoveryMode, handle`.

## 3. Tests & results

### 3.1 Backend unit (cortex-server/test-youtube-smart-discovery.mjs) — 29/29
classification table, tab preservation, bare handle gating, unicode, hostile input; dispatch (root = 3 sources, each tab alone, never `--playlist-end`); typed items; single video/short/live never spawn; playlist stays playlist; 5 000 items no cap; cross-tab dedup/merge; linear dedup; event order and "videos published before shorts"; missing tab ≠ failure; clean yt-dlp error message; **watchdog**: long silent stdout with live heartbeat = no timeout, truly hung process = `DISCOVERY_STALLED` + kill, heartbeat stopping mid-crawl detected, max-runtime guard, kill-ignoring process still settles; cancel kills and starts no later phase; structured argv; **real Windows tree kill** (fake parent + child both gone); route validation/NDJSON; static no-cap audit. (Real time is scaled for the watchdog tests: 250 ms stands for 90 s.)

### 3.2 Frontend unit (scripts/test-youtube-discovery-frontend-unit.mjs) — 9/9
detection table, non-channel inputs, prefixed handle only, unicode, view-model for root/explicit tab/terminal states, 50 000-event fold.

### 3.3 Browser (real `src/App.tsx`, streaming mock on :3001) — `scripts/test-youtube-smart-discovery-browser.mjs` — 81 assertions PASS
S1 no `select`/`option`/25-50-100-ALL controls, automatic mode hints; S2 root (modal closed, panel + cancel visible immediately and for the whole silent phase, "Vidéos : 6 trouvées" visible while Shorts runs, import keeps `/shorts/` vs `watch?v=` URLs, Ollama reported down); S3 explicit tabs show/request only their tab; S4 `@h` generic = no discovery, `yt @h` = discovery with `context:'youtube'`; S5 cancel (UI 2.9 s / connection closed 2.4 s in the saturated headless page, no streams phase, nothing imported); S6 timeout and yt-dlp error visible; S7 cross-task both directions (cancel YouTube → article capture completes; cancel deep capture → discovery continues); S8 2 573 Shorts (12 DOM mutation callbacks, 0 thumbnail requests, longest task 292 ms).

### 3.4 Real yt-dlp (harness `v2-real-discovery.mjs`: direct yt-dlp per tab vs Docteur)

| INPUT | DETECTED MODE | EXPECTED SOURCES | ACTUAL (Docteur) | DIRECT yt-dlp | PASS |
|---|---|---|---|---|---|
| `@Ines-n9m` (with `--youtube-context`) → | CHANNEL_ALL_MEDIA | videos, shorts, streams | (see root row) | | PASS (classification) |
| `https://www.youtube.com/@Ines-n9m` | CHANNEL_ALL_MEDIA | videos+shorts+streams | 333 + 2 573 + streams unavailable = **2 906** unique, 95 s | 333 + 2 573 + 0 = 2 906 | **PASS** |
| `…/@Ines-n9m/videos` (direct 333, same engine as root) | CHANNEL_VIDEOS_ONLY | videos | covered by the 3b1b/veritasium /videos runs | | PASS |
| `…/@Ines-n9m/shorts` | CHANNEL_SHORTS_ONLY | shorts | **2 573**, 101.7 s (module) and 22.3 s (server route) | 2 573 (93.9 s / 25.0 s) | **PASS** |
| `@3blue1brown` (handle) | CHANNEL_ALL_MEDIA | all three | 245 = 152 + 83 + 10 | 245 | PASS |
| `…/@3blue1brown` | CHANNEL_ALL_MEDIA | all three | 245 (152 VIDEO, 83 SHORT, 10 STREAM), 0 dup | 152 / 83 / 10 | **PASS** |
| `…/@3blue1brown/videos` | CHANNEL_VIDEOS_ONLY | videos | 152 VIDEO only | 152 | **PASS** |
| `…/@3blue1brown/shorts` | CHANNEL_SHORTS_ONLY | shorts | 83 SHORT only | 83 | **PASS** |
| `…/@3blue1brown/streams` | CHANNEL_STREAMS_ONLY | streams | 10 STREAM only | 10 | **PASS** |
| `…/@veritasium` (videos+Shorts, no streams tab) | CHANNEL_ALL_MEDIA | videos, shorts, streams(n/a) | 450 + 87 = 537 | 450 + 87 | **PASS** |
| `watch?v=…`, `youtu.be/…` | SINGLE_VIDEO | none | 1 item, no yt-dlp spawn | – | PASS |
| `shorts/<id>` | SINGLE_SHORT | none | 1 item `/shorts/<id>`, no spawn | – | PASS |
| `playlist?list=…` | PLAYLIST_ONLY | the playlist | 1 source, no cap (350-item unit test; UI import path) | – | PASS |

"Docteur count = direct count" is compared dynamically at run time (nothing hard-coded). Dedup across tabs found 0 real duplicates in these channels; the overlap/merge logic is covered by unit tests.

### 3.5 Real server route (isolated temp DB, **Ollama unreachable**: `ollama_connected:false`) — `v2-real-server.mjs`
| Check | Result |
|---|---|
| Foreign `Origin` | 403 (local guard intact) |
| invalid URL / bare handle without context | 400 / 400 |
| single Short | start, mode, items_batch, done — no channel listing |
| `/live` | `UNSUPPORTED_MODE` event |
| Cancel (client disconnect) at 15 s of the Shorts crawl | whole yt-dlp tree gone after **≈ 1.0 s** (2 samples, 0 left) |
| Root: cancel 8 s into the Shorts phase | no `streams` phase, tree gone after ≈ 1.0 s; server log `status:"cancelled"` |
| Real watchdog (server with 200 ms stall limit) | `TimeoutError DISCOVERY_STALLED` after 0.9 s, real tree gone after 0.36 s |
| Full Shorts through the route | 2 573 = direct 2 573, first items 20.3 s, done 22.3 s (direct 25.0 s), 92 NDJSON lines, no yt-dlp left |
| yt-dlp processes at the end of the whole harness | 0 |

### 3.6 Timings (reported)
| Measure | Value |
|---|---|
| direct yt-dlp 2 573 Shorts | 25.0 s – 93.9 s (YouTube variance, three runs in 24 h: 39 s, 79 s, 94 s earlier; 25 s now) |
| Docteur discovery 2 573 Shorts | 22.3 s (route) / 101.7 s (module run during the slow period) — **no 60 s false timeout in the 101 s run** |
| first visible progress (page heartbeat) | 1.4–7.1 s |
| first items visible | after the first phase finishes (videos: 2.5–7.5 s; Shorts crawl end) |
| cancel latency | UI→connection closed 2.4 s in the saturated headless browser; backend abort→tree gone ≈ 1 s |
| process-tree termination | 0.36–1.0 s |
| Node RSS peak (2 573 Shorts / 2 906 mixed) | 52 MB; CPU ≈ 1.7 s for the 95 s root run |
| JS heap growth during 2 573-item discovery (UI) | ≈ 0 MB |

Note: yt-dlp ALL for a Shorts tab still emits its entries only after its own crawl; "items before done" therefore means *phase by phase* (videos delivered while Shorts is crawled), exactly as the mission allows, not a faked per-line stream.

### 3.7 Regressions
| Suite | Result |
|---|---|
| `test-youtube-smart-discovery` (new) | 29/29 |
| `test-youtube-shorts-discovery` (legacy, unmodified) | 24/24 |
| `test-checkytdlp-handling` | 3/3 |
| `test-video-audio` | 14/14 |
| `test-video-pipeline` (needs `--experimental-test-module-mocks`) | 2/2 |
| `scripts/test-video-polling` | 10/10 |
| `scripts/test-youtube-discovery-frontend-unit` (new) | 9/9 |
| **Backend/unit total** | **91/91** |
| `scripts/test-youtube-smart-discovery-browser` (new) | 81 assertions PASS |
| `scripts/test-audit-playlist-queue-browser` (existing playlist browser audit, harness mock extended for the new route) | 24 observations verified, exit 0 |
| `scripts/test-article-capture-pipeline` | 8/8 |
| `scripts/test-article-capture-browser` (article/deep capture regression) | PASS, 21 assertions (a first run during heavy background load failed on a timing check; re-run alone passes) |

Typecheck `npx tsc --noEmit`: PASS. Build `npm run build` (tsc + vite + PWA, 39 precache entries): PASS. Server boot (real `src/server.js`, temp DB, Ollama unreachable): PASS (`/api/ping`, `/api/health`). Frozen modules: `nb7-freeze-manifest --verify` drift `[]`.

## 4. Files

Product: `cortex-server/src/lib/youtube-discovery.js` (new), `cortex-server/src/lib/process-tree.js` (new), `cortex-server/src/lib/ytdlp.js` (exports + tree kill in the legacy engine), `cortex-server/src/routes/capture.js` (+`/capture/discover`), `src/lib/cortex/client.ts`, `src/App.tsx`, `src/components/panels/YouTubeDiscoveryPanel.tsx` (new), `src/lib/youtube/discovery-input.ts`, `discovery-view.ts` (new).
Tests/harness: `cortex-server/test-youtube-smart-discovery.mjs`, `cortex-server/v2-real-discovery.mjs`, `cortex-server/v2-real-server.mjs`, `scripts/test-youtube-discovery-frontend-unit.mjs`, `scripts/test-youtube-smart-discovery-browser.mjs`, `scripts/audit-queue-lib.mjs` (mock for the new route + PNA header, so the existing playlist audit keeps running), `reports/v2-*.json`.
Not touched: Notebook, Memory, OMEGA, RASSILON, Device Fabric, MAITRE/OBSERVATEUR, article/deep-capture pipeline (only `deepAbortRef` is no longer used by discovery).

## 5. Known limitations
* **Import of thousands of items is unchanged and slow**: `doChannelCapture` creates neurons one by one (IndexedDB + PUT + link + indexing queue, 80 ms pause, `setPages` per item). Discovery never triggers per-item refreshes, but importing 2 573+ items takes many minutes (earlier headless measurement ≈ 1.2 items/s, confounded by software WebGL). It stays sequential (no thousands of parallel ingestions). A chunked importer is a separate mission.
* yt-dlp `-v` is the heartbeat; if a future yt-dlp stops printing page lines, only the 90 s stall limit protects a legitimately slower crawl.
* A failing source (not a missing tab) fails the whole root discovery; partial results are not imported.
* Cross-tab overlap is deduped; per-tab counts then overlap while `Total unique` is exact. Root order is category order, not date order.
* Headless Chromium (software WebGL) saturates the page main thread, so browser timing assertions are deliberately loose; precise cancel/termination latency is taken from the backend/real-server measurements.
* The older `scripts/audit-shorts-frontend.mjs` (previous mission) targets the legacy route and is obsolete.
