# DOCTEUR REC-DL-1 — One-click local recording download (2026-10-16)

**State: ~~`BLOCKED_NO_RECORDER`~~ → `RECORDER_AVAILABLE`.** RECORDER-1 now provides the Recorder catalogue and `openRecording()`, so REC-DL-1 was resumed and implemented (backend route + isolated UI).

**Verdict of the resumed mission: `REC_DL_1_PASS_WITH_WIRING_BLOCKED`.** Download works end to end in the isolated panel and route. The only missing piece is product mounting (`server.js`, `App.tsx`: KG-mixed files).

Part B (below) is the original Phase 0 audit, kept as history; for publication, its notes on weaknesses of other, existing file-serving paths were summarised without their details.

---

# Part A — Resumed implementation (after RECORDER-1)

## A1. Reuse, not a second system

- No new store, table or recorder. The download path is the Recorder's own **`service.openRecording(recordingId)`**:
  1. READY row;
  2. confined key (`resolveKey`, realpath, redirected directory refused);
  3. `lstat` (regular file, not a link);
  4. read-only open;
  5. **`fstat` on the descriptor** (same dev + ino, catalogue size);
  6. optional checksum through the descriptor.
- The route never opens by path. `routes/recorder.js` imports **no** `node:fs` (checked by a test).
- No existing file-serving helper is reused for opening the file: the download always streams from the validated descriptor.

## A2. Route

`GET /recorder/recordings/:recordingId/download` lives in the existing `createRecorderRoute` factory. It is **not registered** in `server.js`; once mounted under `/api` it rides the NB-7 central local guard like every other route.

**Input:**
- `recordingId` only (`rec_<32 hex>`). Anything else → `400 INVALID_RECORDING_ID`, or 404 when the router has already normalised the path.
- Query parameters (`path`, `file`, `storageKey`) are ignored: the response is still exactly that recording.

**READY only.** Every other status is refused with a structured code:

| Recording status | Response |
|---|---|
| PREPARING, RECORDING, FINALIZING, FAILED, CANCELLED, DELETING | `409 RECORDING_NOT_READY` |
| MISSING | `404 RECORDING_FILE_MISSING` |
| Unknown id | `404 RECORDING_NOT_FOUND` |

Errors are JSON `{ ok: false, error: { code, message } }` plus an `x-docteur-recorder-error` header. They contain no path and no stack.

**Response:**

| Header | Value |
|---|---|
| `Content-Type` | the READY recording's validated MIME (never the client's) |
| `Content-Length` | the size **seen on the open descriptor** |
| `Content-Disposition` | `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>` |
| `Cache-Control` | `no-store` (Media Studio convention) |
| `X-Content-Type-Options` | `nosniff` |

**Original file.** No transcode, no FFmpeg: WebM stays WebM, MP4 stays MP4 (tested both).

**HEAD** validates through `openRecording`, then closes the descriptor at once. Hono runs GET handlers for HEAD and drops the body, so without this a HEAD would have left a descriptor open. The UI uses HEAD as its preflight.

## A3. Streaming, memory, abort, concurrency

- **Body:** `handle.webStream()`, a new **pull-only** `ReadableStream` on the Recorder handle. One 64 KiB positional read happens only when the socket asks for more, from the same validated descriptor. It owns the descriptor: closed at the end, on **cancel (client abort)** and on error. A file that shrinks during the read errors the stream rather than ending it "successfully short".
- **Why not `Readable.toWeb`:** measured on the Node 22 runtime in use, with forced GC, it retained **23 MiB for 64 MiB** even with an explicit strategy — no real backpressure. The pull stream retained **0.6–1.1 MiB** with a slow client.
- **Retained memory (forced GC while sampling)** with a fast in-process client: about **18–29 MiB constant**, whatever the size (16 / 64 / 128 MiB measured). This is in-flight loopback socket and client buffering, not proportional to the file. There is no full-file buffer anywhere (no `readFile`, no `arrayBuffer`, no base64).
- **Pool bug found and fixed:** a byte stream **transfers** (detaches) what is enqueued. The first version enqueued `Buffer.allocUnsafe` slices, and small ones come from Node's **shared Buffer pool**, so detaching it corrupted unrelated Buffers (it crashed the test reporter). Each chunk now has its own `Uint8Array`.
- **Client abort** (real HTTP, socket destroyed mid-transfer) → stream cancelled → descriptor closed (proved by `EBADF` on `fstat`). **Leaked descriptors: 0** (5 opened per run, all closed).
- **Concurrent downloads:** two simultaneous downloads of the same recording give identical SHA-256. There is no lock; each download has its own descriptor.
- **Delete race:** a delete issued while a download is streaming returns **`DELETED`** on Windows (Node opens with share-delete). The open descriptor keeps delivering **exactly the recorded bytes** to the end, and a later download gets `404 RECORDING_NOT_FOUND`. Where an OS refuses the unlink, RECORDER-1's `DELETE_INCOMPLETE` applies. The stream can never switch to another file.

## A4. TOCTOU guarantees kept

- **Tested through the route:**
  - a swap between the check and the open → `409 FILE_CHANGED`, nothing streamed;
  - an appended byte → `409 SIZE_MISMATCH`;
  - a directory in place of the file → `409 NOT_REGULAR_FILE`;
  - a junction / redirected `files/` → `500 ROOT_ESCAPE`, never the sentinel.
- **Checksum policy:** downloads do **not** re-hash by default (it would read every file twice). `?verify=1` re-hashes through the descriptor first (`409 CHECKSUM_MISMATCH` on tamper). Integrity is anchored by the SHA-256 computed at finalization and kept in the catalogue.
- **Limits (unchanged from RECORDER-1, §10 of the Recorder report):** Windows has no `O_NOFOLLOW`, so a swap is detected rather than prevented. In-place modification of an already-open file by another local process is only caught by `?verify=1`, at open time.

## A5. File name

| Case | File name |
|---|---|
| Titled | sanitized title + real extension (RECORDER-1 `downloadFilename`, built on Media Studio `safeDisplayName`) |
| Untitled (default title of its type) | deterministic `recording-<UTC YYYY-MM-DD_HH-MM-SS>-<8 hex of the id>.<ext>` |
| Reserved name (`CON`…) | `enregistrement.<ext>` |

- **Neutralised:** `" ' \ / : * ? < > |` and control characters. CR / LF in a title are refused at the source (`INVALID_TITLE`). The header builder strips control characters again, so CRLF injection is impossible (tested).
- **ASCII fallback:** accents folded, other non-ASCII (per code point) → `_`, and `" \ ' % ;` neutralised.
- **`filename*`:** RFC 5987 UTF-8 with `' ( ) *` percent-encoded, so Unicode is preserved. Chromium saved `Réunion d’équipe — été 🎥.webm`.
- **MIME hardening found during this mission:** RECORDER-1's MIME validator allowed `\s` in the codecs parameter (it matches CR / LF) and trimmed before matching. Since the stored MIME becomes `Content-Type`, the validator now accepts plain spaces only and refuses any control character, even trailing.

## A6. UI (isolated)

- **`RecordingDownloadButton`** (new) is rendered **only** for `status === READY` with a valid id (`canDownload`). It appears in `RecorderPanel` on the result of the capture just finished, and in a new **"Enregistrements récents"** list (metadata only, read at mount and after each capture; FAILED / CANCELLED / MISSING items show their status and no button).
- **States:** `Télécharger` → `Téléchargement…` → `Téléchargement lancé` (never "téléchargé"); `Indisponible`; `Fichier manquant`; `Erreur` (retry possible).
- **Flow:** only from a click / Enter / Space (there is no effect in the component), then:
  1. `port.checkDownload(id)` — HEAD; the server validates the real file, no body is read;
  2. `startNativeDownload(port.downloadUrl(id))` — a hidden `<a>` click, so the **browser's download manager** receives the stream.

  The renderer never calls `blob()`, `arrayBuffer()`, `FileReader` or `createObjectURL` (counted in the harness: 0). The browser chooses the download folder, so no `FILES.USER_SELECTED_WRITE` is involved.
- **`http-port.ts`:** `downloadUrl(id)` refuses any non-id (paths, UNC, `file://`, storage keys) **before** any request; `checkDownload(id)` is HEAD only.

## A7. Audit

`RECORDING_DOWNLOAD_STARTED` / `FAILED` were **not** added to `recorder_audit`. Its `CHECK` event list cannot be widened without rewriting that append-only table, and a new table was out of scope ("0 nouvelle table").

Instead, the route logs `recorder download started` / `recorder download refused` through the injected logger with recordingId, size, MIME and method (or code) only. There is no "completed" event: the server cannot know that the browser saved the file.

## A8. Root Policy

**NO_NEW_CAPABILITY_REQUIRED.** The download is a read of a READY recording already stored in Docteur's own folder, streamed to the local browser, behind the existing local guard. No Root Policy action covers it today, as for Media Studio file reads. Root Policy was not modified.

## A9. Tests

| Suite | Result |
|---|---|
| `cortex-server/test-recorder-download.mjs` (new) | **9 / 9** × 3. READY download (WebM / MP4), READY-only (7 statuses + unknown / malformed), sentinel `REC_DL_SENTINEL_DO_NOT_EXPOSE` vs 13 encoded / traversal / UNC / absolute / `file://` attacks + query parameters + junction (RUN), FILE_CHANGED / SIZE_MISMATCH / NOT_REGULAR_FILE / `?verify=1`, filenames (default / Unicode / nasty / CRLF / reserved), HEAD closes the descriptor, real HTTP 64 MiB (slow client 0.6–1.1 MiB retained; fast 18–23 MiB constant), client abort → EBADF, 2 concurrent identical, delete race (DELETED on win32, bytes intact), isolation |
| `scripts/test-recorder-download-unit.mjs` (new) | **5 / 5** × 3. READY-only rule, labels, error mapping, `downloadUrl` refuses paths, `checkDownload` = HEAD with no body read, native download = one hidden anchor click with no fetch, static scan for blob / arrayBuffer / FileReader / object URL / path |
| `scripts/test-recorder-download-browser.mjs` (new) | **7 / 7 scenarios** × 3, **real Chromium downloads**. The route runs on a real loopback HTTP server behind the Vite proxy (Playwright interception does not cover native downloads). Covered: no automatic download, button only on READY, one click → Unicode name, same bytes and size, one HEAD + one GET, 0 renderer body reads; MP4 untitled deterministic name; keyboard Enter / Space; Fichier manquant; Erreur; end-to-end real MediaRecorder capture → download identical to the stored file |
| `cortex-server/test-recorder.mjs` (RECORDER-1) | 13 / 13 (two expectations updated: the download route now exists; `node:stream` allowed) |
| `scripts/test-recorder-ui-unit.mjs`, `scripts/test-recorder-browser.mjs` (RECORDER-1) | 9 / 9; 11 / 11 scenarios (the "no request at load" check now allows the metadata list only) |

## A10. Remaining wiring (KG-mixed files) and limitations

- **Wiring:**
  1. `server.js` — open the Recorder store, `recoverAfterRestart()`, `app.route('/api', createRecorderRoute({ service, logger }))`;
  2. `App.tsx` — mount `RecorderPanel` with `createHttpRecorderPort({ baseUrl })`.
- **Limitations:**
  - Not mounted in the product.
  - Real camera / screen not exercised.
  - Browser test fixtures are synthetic WebM / MP4 headers, plus one real capture of a synthetic canvas.
  - "Téléchargement lancé" means the browser received a download; whether it was saved is the browser's business.
  - The download audit is a log line, not a catalogue event.
  - The HEAD preflight adds one request per click; a file can still disappear between the HEAD and the GET, in which case the browser shows its own failed-download state.

---

# Part B — Original Phase 0 audit (history)

The Phase 0 audit was required before any code. It found that Docteur has **no video recorder**, and therefore no recording store and no `recordingId`. REC-DL-1 forbids creating a second recorder or store ("NE PAS inventer un second système Recorder"). On 2026-10-16 the user chose to stop here rather than rescope the mission.

- Code written: 0.
- Files modified: 0, apart from this report.
- Real user DB: not opened.
- Git index: untouched (KG gate 56 / `e8a2d6d7…` before and after).

---

## 1. What was searched

| Question | Finding |
|---|---|
| A browser recorder (`MediaRecorder`) for video? | **No.** The only `MediaRecorder` in the source is `src/hooks/useVoiceActivation.ts`: it records **voice audio** for transcription. Its webm blob goes to `/api/voice/*` and is written to a temp file (`cortex-server/src/routes/voice.js:96`), never kept as a recording. The other hits are docs, a voice test and a voice harness. |
| Screen capture? | `src/hooks/useScreenShare.ts` (`getDisplayMedia`) is a **live** share for the overlay / OCR. Nothing is recorded. |
| Webcam? | `src/hooks/useGestureCamera.ts` (`getUserMedia`) feeds MediaPipe gesture detection **live**. Nothing is recorded. |
| A backend recorder (FFmpeg `gdigrab` / `dshow` / `ddagrab`)? | **No.** The only "video capture" mention is a contract comment in `investigator-contracts.js` ("audio / video captures only (none in V1)"). |
| A recordings store / table / `recordingId`? | **None** in `cortex-server/src` or `src`. |
| Roadmap | `reports/DOCTEUR_MASTER_EXTERNAL_FEATURES_AUDIT_2026-10.md`, line 301: "**pas** d'enregistreur ni d'export vidéo". Line 306 and line 1685 list "Recorder (RECREATE_NATIVE) — navigateur getDisplayMedia/MediaRecorder ; ffmpeg optionnel" as **to build**. |

The UI states labelled "Enregistrement…" (TopBar, CommandBar) are the **voice** recorder.

## 2. Video files Docteur does write (none of them is a recording)

| Source | Where | Identified by | Download today | Fits REC-DL-1? |
|---|---|---|---|---|
| **Media Studio exports** (FFmpeg render of a user timeline) | `<dirname(SQLITE_PATH)>/media-studio/projects/<projectId>/exports/<jobId>.mp4` | `jobId` (job store of `lib/media-studio.js`) | **Yes, already one click:** "Télécharger le MP4" (`MediaStudioModal.tsx:484`) → `GET /api/media-studio/exports/:jobId/file?download=1` (attachment) | No — an export, not a recording; it already has its download |
| **Media Studio assets** (files the user **uploaded**, sniffed: mp4 / mov / webm / audio / images) | `…/media-studio/projects/<projectId>/assets/<assetId>.<ext>` | `projectId` + `assetId` | Served inline (`/assets/:assetId/file`) for the player | No — an upload, not a recording |
| **OpenMontage renders** | `cortex-server/data/openmontage-workspaces/…/output.mp4` | `jobId` in an **in-memory** `Map` (lost at restart) | `GET /api/openmontage/job/:id/artifact`, inline `video/mp4` | No — a render |
| **Video pipeline** `video-jobs` | `cortex-server/data/video-jobs` | job id | — | **Excluded:** fetched by yt-dlp from external URLs; REC-DL-1 must never become an external-video downloader |
| **Voice temp audio** | `TMP_DIR/<id>.webm` | — | — | No — temporary audio |

## 3. Facts for the future Recorder + download mission

- **Local guard:** the whole `/api` is behind the NB-7 central guard. `applyLocalApiSecurity` in `cortex-server/src/server.js` (around line 1790) checks the Host allow-list, Origin / CSRF and body caps. The Root Policy middleware runs on `*`. A future `GET /api/<recorder>/recordings/:recordingId/download` route would sit behind both, but registering it requires **`cortex-server/src/server.js` (protected, KG-mixed)**. Its UI URL helper would naturally live in **`src/lib/cortex/client.ts` (protected)**. Both have wiring stops.
- **Existing streaming conventions:** Media Studio already streams its files without a full buffer, supports byte
  ranges, sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and builds `Content-Disposition` as
  ASCII `filename` + `filename*=UTF-8''…`. These header and streaming conventions are the ones to reuse.
- **File confinement still to harden (not fixed):** this audit noted that some existing file-serving paths for
  Docteur-produced videos use weaker open-time and confinement checks than a recorder download needs. A recorder
  download should open the file first, check the open descriptor and its confinement, then stream from that
  descriptor. Hardening those existing paths was out of scope: it was not done here and is not claimed as done.
- **Root Policy:** streaming an already-stored local file to the local browser is READ_ONLY in principle, and the Media Studio file routes use no Root Policy action today. The Companion COMP-5 catalogue already records this as `COMPANION.RECORDING.DOWNLOAD — EXISTING_CAPABILITY_SUFFICIENT` if it only streams an authorised file. Saving to a user-chosen path would need `FILES.USER_SELECTED_WRITE`. No capability is needed **for a download**, but none can be confirmed until a recorder exists.
- **Formats:** with no recorder, there are no "formats really produced" to allow-list. A browser `MediaRecorder` typically produces `video/webm` (VP8/VP9/Opus) in Chromium. Media Studio's magic-byte sniffer (`lib/media-studio.js`, around lines 54–67) already recognises webm / mp4 / mov and could validate a recording's real type server-side.

## 4. Options left to the user

1. **Recorder mission first** (master audit item "Recorder — RECREATE_NATIVE"). It would add a capture source, a recording store (id, logical title, server-resolved file, real sniffed type) and retention / delete rules. REC-DL-1 then becomes a small typed route plus a button on that store. The server route and client helper hit the protected KG-mixed files until the KG commit decision.
2. **Rescope REC-DL-1 to Docteur-produced videos** (Media Studio exports, OpenMontage renders): harden the file confinement and download handling of the existing paths, with sentinel / traversal tests. Media Studio exports already have their button. A new OpenMontage download in the UI likely needs `client.ts`.
3. **Leave as is.** Today's Media Studio export download keeps working.

## 5. Checks performed

- KG gate before and after: 56 paths, SHA-256 `e8a2d6d7225541bf5b212d8af6733cd2bacc858394e0784a0969562423abe789`.
- Read-only searches over `src/`, `cortex-server/src/`, `reports/`, `docs/`. No test run (no code changed), no server started (`:3001` free), no network.

---

## REC-WIRE-1 — product download wiring (2026-10-16)

REC-DL-1 is now reachable from the real Docteur shell. The product path remains exactly:

`recordingId → openRecording(recordingId) → validated descriptor → pull-only stream → native browser download`.

- `server.js` mounts the existing Recorder route factory once under `/api`; no duplicate download endpoint or path-based open was added.
- `App.tsx` mounts the existing `RecorderPanel` and existing HTTP port. READY results and READY recent items expose the existing `RecordingDownloadButton`.
- The renderer still performs only the HEAD availability check and a native hidden-anchor navigation. It does not read the body, create a Blob/object URL, accept a filesystem path or transcode.
- The real-App Chromium harness downloaded the original WebM bytes, with correct Unicode filename, MIME and size. After closing/reopening the same temporary catalogue and running recovery, the recording remained listed and downloadable with identical bytes.
- Missing files, `FILE_CHANGED`, 404/not-ready, injected write failure, permission denial, BACKPRESSURE and FAILED states remain covered by the core/UI/browser suites; no raw stack or path reaches the UI.
- The route remains behind Docteur's central local request guard. `test-nb7-local-api-security.mjs` passes **13/13** after wiring, and the CORS preflight permits the session header required for chunk uploads.
- Sentinel results: `REC_DL_SENTINEL_DO_NOT_EXPOSE` never readable; `RECORDER_SENTINEL_DO_NOT_TOUCH` never opened/written/deleted.
- Test data root: OS temporary directory only. Real user DB change: 0. Real user recording created/accessed: 0. External/cloud calls: 0.

Product and stability results:

| Suite | Result |
|---|---|
| `test-recorder-download.mjs` | **9/9 PASS** |
| `test-recorder-download-unit.mjs` | **5/5 PASS** |
| `test-recorder-download-browser.mjs` | **7/7 scenarios, 40 assertions PASS** |
| `test-recorder-product-browser.mjs` | **PASS × 3 consecutive runs** |
| Typecheck / build / bundle inclusion | **PASS / PASS / PASS** |

Remaining limits: real hardware capture was not run; the browser download manager confirms the received file, while the user's later filesystem choice remains browser-owned by design.

**Verdict: `REC_WIRE_1_PASS_WITH_LIMITATIONS`.**

---

## RECORDER-CERT — final download certification (2026-10-16)

RECORDER-CERT changed no product source. All download evidence used isolated OS-temporary Recorder roots; the real user DB and real user recordings were not opened or modified.

- Physical camera/screen/microphone capture and a download derived from physical hardware are `NOT_RUN`: the unattended harness deliberately uses fake camera/microphone devices and a synthetic canvas, blocks real `getDisplayMedia`, and had no attended permission chooser. It therefore makes no physical-device or visual indicator claim.
- The isolated real-browser substitute passed: real `MediaRecorder` produced a WebM, the product's native download manager saved it, and the saved file matched the Recorder's validated open handle byte-for-byte. Unicode filename, extension, MIME, size, HEAD preflight, GET, keyboard activation, missing-file behavior, MP4 fixture, and zero renderer buffering passed.
- Restart passed in three consecutive real-App product runs: after store/service reopen and recovery, the READY recording remained listed and downloadable with identical bytes.
- Core download passed **9/9**, UI unit **5/5**, browser **7/7 scenarios / 40 assertions**, and product integration **3/3 consecutive runs**.
- `REC_DL_SENTINEL_DO_NOT_EXPOSE` and `RECORDER_SENTINEL_DO_NOT_TOUCH` were not exposed. Malformed ID, traversal, encoded traversal, absolute path, UNC, query-path input, and redirected-directory junction attacks were refused. The file-symlink sub-case was `NOT_APPLICABLE` without symlink privilege; the junction sub-case ran.
- Safe open remains `recordingId → catalogue metadata → confined open → descriptor identity/type/size validation → stream that same descriptor`. The tested swap returned `FILE_CHANGED`; Windows still lacks a complete `O_NOFOLLOW` guarantee, so this is detection for the covered race rather than a universal TOCTOU claim.
- The real HTTP 64 MiB case remained memory-bounded; client abort closed the stream/descriptor, and concurrent downloads returned identical bytes. Delete-during-download kept the already-open file identity.
- Recorder external/cloud calls, FFmpeg, and transcoding remained zero. Backend delete passed; Delete UI remains intentionally `NOT_IMPLEMENTED`.
- `FULL_SERVER_PROCESS_NOT_RUN`: not every unrelated `server.js` service data root has a documented complete temporary override. The isolated route/service/product harnesses exercise download wiring without risking user data.
- Typecheck, production build, and Recorder bundle inclusion passed. The required Media and security regression matrix also passed.

**Verdict: `RECORDER_CERT_PASS_WITH_LIMITATIONS`.**
