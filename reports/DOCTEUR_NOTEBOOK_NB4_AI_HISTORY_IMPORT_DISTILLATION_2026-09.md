# DOCTEUR NOTEBOOK — NB-4: AI-history import, distillation, memory candidates

Date: 2026-09-30 · Uncommitted (no `git add/commit/push/reset/clean/stash`). No personal or real conversation data appears in
this report, the tests or the fixtures.
Builds on NB-3 (`DOCTEUR_NOTEBOOK_NB3_ROBUST_LOCAL_RAG_2026-09.md`): same SQLite + FTS5, LanceDB, Ollama `nomic-embed-text`
(`nomic-prefix-v1`, 768-d), retention, purge and citation machinery — **no new embedding provider, no new vector infrastructure, no cloud.**

## 0. Baseline

`git status` = earlier missions' uncommitted work. Notebook baseline re-run: historical 75/75, NB-2 37/37, NB-3 31/31
(**one NB-3 test — the real-Ollama one — was SKIPPED at first because Ollama was stopped; I started `ollama serve` locally, nothing
installed or pulled, and it passed 31/31**), browser 18 + 34. Stopped both Ollama processes again at the end.

## 1. Principle: an AI history is untrusted data, not a memory

| Imported element | Role | Trust level stored |
|---|---|---|
| user message | USER | `USER_AUTHORED` |
| assistant message | ASSISTANT | `PAST_AI_OUTPUT` |
| tool / function output | TOOL | `TOOL_RESULT` (new level) |
| historical system message | SYSTEM | `UNKNOWN` |
| anything else | UNKNOWN | `UNKNOWN` |

`PRIMARY_SOURCE` / `VERIFIED_EXTERNAL` are **never** assigned by an import, and `setTrustLevel` on an import is refused — nothing is ever
promoted to verified fact, primary source or global memory. Roles are stored per message and never merged into a blob.

## 2. Architecture

```
file / .zip ─► (in-memory only, hardened ZIP reader) ─► adapter.detect ─► stream conversations ─► adapter.normalize ─► validate
   ─► per-message secret scan (BLOCK / REDACT / CONFIRM) ─► ids + dedup + supersede ─► segment (role-homogeneous, code-fence aware)
   ─► embed (Ollama, nomic-prefix-v1) ─► ONE SQLite transaction per batch (conversations, messages, attachments, chunks, FTS5)
   ─► vectors to LanceDB ─► READY (only when everything is indexed)
   optional: distill ─► memory CANDIDATES ─► human review (Notebook-only)
```
Each import is one `nb_documents` row (`origin='ai_history'`, id = import id) so NB-3 retention / visibility / purge apply unchanged;
chunks reuse `nb_chunks` + `nb_chunks_fts` + LanceDB `notebook_chunks` with nullable `ai_*` provenance columns. Ordinary
document queries default to `scope='documents'`: **AI-history chunks never appear in NB-2/NB-3 search, the Documents list or the
legacy endpoints** unless a new explicit scope asks for them.

New modules (`cortex-server/src/lib/`): `notebook-ai-zip.js` (ZIP + streaming JSON), `notebook-ai-adapters.js`, `notebook-ai-segmenter.js`,
`notebook-ai-schema.js` / `notebook-ai-store.js`, `notebook-ai-distill.js`, `notebook-ai-history.js` (service), `notebook-unified.js`;
route `routes/notebook-ai-history.js`; UI `NotebookAiHistoryPanel.tsx`.
Small additive edits: `notebook-docs-store.js` (scope/filters, cascade, columns), `notebook-documents.js` (filter pass-through,
`internals`, trust guard), `notebook-retrieval.js` (`diversityBy: 'conversation'`), `notebook-security.js` (speaker labels, AI prompt),
`notebook-documents-runtime.js`, `server.js` (2 lines), `NotebookModal.tsx` (tab), `client.ts`.
**No frozen module touched** (Device Fabric, OMEGA V1/V2, RASSILON, MAÎTRE, Observateur: 0 files).

## 3. Adapters and REAL vs SYNTHETIC coverage

| Adapter | Reads | Coverage |
|---|---|---|
| `CHATGPT_EXPORT` | `conversations*.json` (top-level array, `mapping` tree, `current_node`) | **SYNTHETIC_ONLY** |
| `CLAUDE_EXPORT` | `conversations.json` (`chat_messages`, `sender`) | **SYNTHETIC_ONLY** |
| `GEMINI_EXPORT` | Takeout `MyActivity.json` (header "Gemini Apps", prompt + `safeHtmlItem`) | **SYNTHETIC_ONLY** |
| `GENERIC_JSON` / `GENERIC_MARKDOWN` / `GENERIC_HTML` / `GENERIC_TEXT` | role-marked or role-keyed content | tested (own fixtures) |

**No real export was available**: a filename-only search of Downloads, Documents, Desktop and the project found none, and nothing was
opened. The provider structures are hand-written imitations of the publicly documented shapes and were never validated against a real
export — **real-export validation: NOT_RUN**; do not read "PASS" on a provider adapter as "works on real ChatGPT/Gemini/Claude exports".
Adapters never invent fields and report an unrecognised structure (`UNSUPPORTED_FORMAT`) instead of guessing.
**Provider attribution:** a provider is named only when its structure is recognised (`providerVerified`). Generic files stay `UNKNOWN`
even when a label says "ChatGPT" (tested); a user-declared provider is recorded (`counts.declaredProvider`) but never trusted; UI/prompts
then say « provider non vérifié ». Each adapter exposes `detect / conversations(parse) / normalize / validate` and returns provenance.

## 4. Hardened ZIP reading (no extraction to disk)

Pure-Node reader (`zlib.inflateRaw` + `crc32`), entries are inflated in memory as bounded streams and only for names an adapter asks for.
Refused (each tested): `../` and encoded traversal, absolute paths, drive letters, UNC, `file://`/URL names, NUL bytes, symlink entries,
encrypted entries, nested archives (never opened, reported), duplicate names, ZIP64 / multi-disk, unsupported methods. Limits (env / options):
archive 500 MB, 5 000 entries, 1 GB per entry, 2 GB total extracted, compression ratio ≤ 300 (measured on the **real** output, so a lying
header cannot bypass it), CRC-32 verified. Test evidence: 30 MB of zeros compressed to ~30 KB is stopped by the ratio cap; an entry declaring
100 bytes but inflating to 5 MB is stopped by the real-size cap. The import path performed **0 `fs` reads/writes** (spied). The upload
is discarded after import — only normalised rows, hashes and provenance are stored.

## 5. Attachments

References are matched **only against entry names physically present in the chosen import**; `../../x`, `C:\…`, `file://…`, UNC and
absolute paths are `SECURITY_BLOCKED`; absent files `MISSING`; present binary types `UNSUPPORTED`; else `AVAILABLE`. **`AVAILABLE` never
means indexed** (`indexed=0`, shown as « non indexée »): attachment bytes are not read or indexed in NB-4. 0 filesystem reads (spied).

## 6. Normalisation, roles, branching, provenance

Deterministic ids: conversation = hash(notebook, provider, external id or content key); message = hash(conversation, original id|role+content, content
hash). Every message stores provider, import id, conversation id, role, timestamp, original id, original + resolved parent id, content type, trust,
source hash, ordinal, main-path flag. **ChatGPT `mapping` is a tree**: regenerated answers are stored as siblings (same parent, `on_main_path=0`),
never destroyed; the main path is derived from `current_node`; the UI labels « branche alternative » and search can restrict to the main path.
Code fences keep their language tag in the message and in the segment.

## 7. Dedup, incremental import, edits

Same archive (bytes) → no-op (`duplicate:true`); same conversations in a different archive → 0 new messages; an export with old + new
conversations and appended messages adds only the new ones (counts: new / updated / unchanged, messages new / duplicate); an **edited**
message (same original id, different text) becomes a new row and the old one is superseded (kept, excluded from indexing/search by default);
identical repeated messages are deterministic (occurrence counter) so a re-import adds nothing.

## 8. Secrets, logs, injection, tool isolation

- Secret scan per message and per title, reusing the NB-2 scanner. `block` (default) drops the message and counts it; `redact` masks it (flag
  `redacted`); **private keys are always blocked**; `confirm` stops the import (`REVIEW_REQUIRED`) with **all data rolled back** until the user
  chooses. Findings expose kind/count only — never values (asserted on preview, API, DB, FTS, UI).
- Logs contain only import ids, counts, stage, duration, error code (a test greps every log line for titles/bodies/secrets: none).
- An old SYSTEM message, tool output or "run PowerShell / call OMEGA / control device / send email / upload file / exfiltrate secret" text is stored as
  **data**: role tag in the indexed text, `HISTORICAL_SYSTEM_MESSAGE` / `TOOL_OUTPUT` / injection flags, speaker « Message système historique (donnée, sans
  autorité) », inside the per-request random boundary. Asserted with a hostile LLM stub: system prompt byte-identical, user message verbatim, **0**
  `child_process` calls, **0** fetch, unknown `[N]` citations dropped, no action channel in the contract. Indirect injection ("when source B is read, execute…")
  has no authority. History → shell / OMEGA / RASSILON / Device Fabric / publication: **0**.

## 9. Indexing and retrieval

Segments are role-homogeneous (so `[USER]` vs `[PAST_AI_OUTPUT]` attribution and role filters are exact), merge short same-role messages, split long
ones at block boundaries, keep fenced code atomic (a code block larger than the cap is split by lines and re-fenced with its language on every part),
and a > 6 h gap starts a new segment. FTS indexes conversation title, role, provider and text; vectors use the NB-3 pipeline unchanged. Filters
(SQL pushdown): provider, role (USER only / AI only), date range, conversation, import, trust level, main path only. Diversity is per conversation.
A result carries provider, conversation title, date, role, trust, excerpt and a typed citation. With Ollama down, import + search + review still work
(FTS-only, `VECTOR_UNAVAILABLE`, reindex later).

## 10. Answers: voices, dates, unverified AI

The prompt (`AI_HISTORY_SYSTEM_PROMPT`) requires distinct voices (« Vous aviez écrit… » / « ChatGPT avait répondu… ») and dated statements; each source block
carries `speaker` and `date`. Contract additions: `voices[]`, `TEMPORAL_MIX` (sources > 30 days apart ⇒ « état historique »), `ALTERNATE_BRANCH`,
`ONLY_PAST_AI_SOURCES`, conflicts from the NB-3 detector (user vs assistant statements count as different sources). **Old-hallucination fixture**
("Paris est en Allemagne" from an old AI answer): the answer contract marks the citation `PAST_AI_ASSERTION` / `UNVERIFIED_PAST_AI`, adds
`ONLY_PAST_AI_SOURCES`, and the prompt labels it « ancienne réponse IA, non vérifiée ». The detector cannot decide that "Allemagne" contradicts a
France statement (lexicon/number based) — it is labelled unverified, not refuted.

## 11. Citations

`AI_HISTORY_MESSAGE` citations: import id, conversation id + title, provider (+ verified flag), role, trust, assertion class, message ids, date, chunk id,
hash. Validation: chunk exists in this notebook, is visible (retention / session / READY), hash unchanged; fake, tampered, foreign-notebook, deleted and
expired are rejected. Preview returns the exact stored chunk **and** the real messages behind it. Unified citations are typed `NEURON | DOCUMENT_CHUNK |
AI_HISTORY_MESSAGE` with namespaced ids (`neuron:…`), so no id is ambiguous.

## 12. Distillation → MEMORY CANDIDATES (Notebook-scoped)

Deterministic FR/EN rules (unicode-aware): decisions, preferences, requirements, todos, open questions (unanswered user questions), project facts, personal
notes, code snippets, assistant-claimed technical discoveries. Candidate = `candidateId, type, statement, sourceMessageIds/evidence (message, conversation,
import, role, quote, date), trustLevel (from evidence roles), assertionType, confidence (never 1.0), status, method`. **AI-only candidates stay
`PAST_AI_OUTPUT` and are capped at 0.5; LLM-only candidates are capped at 0.6.** Grouping: the same decision stated 40 times across 40 conversations = **1
candidate with 40 evidence links** (cue phrases such as « nous avons décidé » / « on a décidé » are stripped before comparing). Supersession: "remplacer X par Y"
and same-topic decisions on different dates produce **possible** links (newer→older, dated, explicit vs ambiguous) — **no status is ever changed
automatically**; the old decision is not silently kept nor dropped. Optional local LLM pass: only if the configured model is *already* installed
(`LOCAL_MODEL_UNAVAILABLE` otherwise — nothing is pulled/installed); its output is untrusted: numbered messages (no internal ids), strict JSON, each statement must be
lexically supported by a cited message, instruction-like statements dropped (hallucinated / malformed / bad-ref / injected proposals rejected in tests).
Measured on 13 labelled fixture sentences: precision ≥ 0.85, recall ≥ 0.7, wrong attribution 0, unsupported 0, duplicate rate 0 — a tiny sanity fixture, not a benchmark.
Real local run (llama3.2:3b): 5 proposed → 3 accepted, all evidence linked to real messages.

## 13. Human review — and the global-memory boundary

Only `reviewCandidate` changes status: `approve` (→ `APPROVED`, `promotion = NOTEBOOK_ONLY`), `reject`, `edit` (injection-like text refused), `supersede`,
`reopen`. Any other action (e.g. `approve_all`) is refused; there is no bulk endpoint and no UI control. Tests prove candidates are `CANDIDATE` until a human acts, that
extraction and approval leave the global memory tables (`preference_facts`, `episodic_memories`) untouched, and (static scan) that no NB-4 module imports the memory
module, a cloud provider or an executor. **Approved candidates are not injected into any prompt** (NB-5 boundary: scoped retrieval before any global memory).
Shared candidates: deleting an import removes only its evidence; a candidate left without evidence is removed if unreviewed, or **kept and flagged `orphaned`**
if a human already reviewed it.

## 14. Deletion, retention, cancellation, races

Deleting an import removes conversations, messages, attachments, chunks, FTS rows, embedding metadata, LanceDB vectors, the source row and unshared
candidates; retrieval, citation preview and verification return nothing afterwards (asserted on counts). Retention KEEP / SESSION_ONLY / DELETE_AFTER are tested
on histories: **real server restart** (isolated temp DB + LanceDB, real Ollama): before restart the session import had messages 2, conversations 1, chunks 2, FTS 2,
embedding metadata 2, vectors 2, candidate evidence 1; after restart **all 0** and its candidate was gone, while the KEEP history was untouched and searchable
(`HYBRID`). Cancel / failure / rejection **roll back everything** (resume was evaluated and not implemented: an interrupted import is rolled back, never left
partially READY); a pending import is invisible to search; races (delete during embedding / during the vector upsert / while queued) leave 0 rows and 0 vectors.
Cross-notebook: the same export in two notebooks is fully separate; ids/citations from another notebook never resolve.

## 15. Unified retrieval (explicit) and legacy stability

`POST /notebooks/:id/unified-search` and `/unified-ask` take `scope: neurons | documents | ai_history | all` (default `all` on the *new* endpoints only). Merge = round-robin over each
retriever's own ranking (cosine and RRF scores are not comparable). **Legacy `/ask`, `/summary` and the NotebookLM export are unchanged**: verified through the
routes with a history present — `/ask` keeps `{answer, chunks_used, citations}` with `chunks_used 0`, `/summary` keeps its shape, and none of them sends history text to the
LLM or writes it into the export (which only lists a « contenu indisponible » row for the new source type, as it already did for documents). No cloud upload path exists.

## 16. Performance (`nb4-benchmark.mjs`, `reports/nb4-benchmark-results.json`)

Synthetic ChatGPT-shaped export, real SQLite + LanceDB + service; pseudo 768-d embeddings (pipeline cost, not Ollama).

| Scale | Export | Preview | Import | Throughput | Chunks | Search p50 / p95 (FTS · FTS+provider+role+date · hybrid) |
|---|---|---|---|---|---|---|
| 10 000 messages | 5.2 MB JSON / 1.2 MB zip | 0.1 s | 1.7 s | ~5 700 msg/s | 10 000 | 1.9/3.1 · 2.9/6.5 · 38/45 ms |
| 100 000 messages | 52 MB JSON / 12 MB zip | 1.2 s | 20.4 s | ~4 900 msg/s | 100 000 | 12.6/29 · 16.5/32 · 255/287 ms |

RSS: 176 MB peak (10k); the 100k figure (442 MB) is not a clean measurement — it includes the earlier scale and the 52 MB generated export held in the same process.
**Real embedding is the cost that dominates**: 66 ms/chunk measured now (28 ms earlier) ⇒ ≈ 11 min for 10k and ≈ 110 min for 100k chunks; FTS-only import is immediate.
1M messages: `NOT_RUN`. Streaming: ChatGPT/Claude/Gemini arrays are split element by element (byte-boundary tested) and processed in bounded batches; generic JSON/MD/HTML/text
are read whole (100 MB cap) and the upload/preview copy lives in memory (≤ 300 MB, 15 min TTL) — so the *upload* path is not RAM-flat.

## 17. Strict Local proof, offline, XSS, accessibility

- Backend: every non-loopback connection refused and recorded while a zip import (with remote URLs, `<img>`, `<script>` in messages) → index → search → ask →
  distill → review → delete runs: **0 attempts**. The real-Ollama test asserts loopback-only hosts. Browser: every non-loopback request aborted, 0 attempts.
- XSS: hostile conversation title, message text, attachment name, code block, candidate statement, evidence quote, provider metadata render as text —
  `window.__xssFired` stays undefined and no element is created (browser test).
- Accessibility: `role=tablist` with arrow-key navigation, labelled controls, delete confirmation that takes focus, citation preview as a focused `role=dialog`
  (Escape closes, focus returns), live regions for status/findings/conflicts, keyboard-only flows. Not run: a screen-reader session.

## 18. Tests

| Suite | Result |
|---|---|
| Historical Notebook files (5) | 75/75 |
| NB-2 | 37/37 |
| NB-3 (incl. real-Ollama + real-PDF tests) | 31/31 |
| **NB-4 `test-nb4-ai-history.mjs`** (incl. real nomic + real local-LLM test, ran) | **44/44** |
| Notebook backend total | **187/187** |
| Browser: NB-2 file / NB-3 file / NB-4 file | 18 · 34 · 44 = **96** |
| All `test-phase*` / `test-batch-*` / Shorts | 0 failures |
| `npm run build` (runs `tsc`) | PASS |
| Server boot ×2 (isolated) + real restart: migrate, preview, import KEEP + SESSION_ONLY, distill, search, review, restart purge, delete, shutdown | PASS; one listener only (127.0.0.1:3931) |
| Secret scan (new files + diff) | 0 non-synthetic secrets (fixtures are `FAKE`) |

Behaviour changes to existing code (all covered by the unchanged NB-2/NB-3 suites): FTS stop-word list gained `selon source sources concernant according regarding about avais avait avons avez`
(so « Où est Paris selon mes sources ? » is not sunk by filler words); `TRUST_LEVELS` gained `TOOL_RESULT`; the Documents list/count exclude `origin='ai_history'` rows.

## 19. Limitations

- Provider adapters are SYNTHETIC_ONLY — **real export validation NOT_RUN**; real ChatGPT/Gemini/Claude exports may differ (Gemini in particular has no
  conversation ids: each activity item becomes its own conversation with a synthetic, flagged id; Takeout HTML activity is not parsed).
- Attachments are referenced, never indexed; inline `extracted_content` of attachments is ignored.
- Distillation is heuristic (FR/EN regexes) plus an optional small local LLM; expect misses and false candidates — that is why review is mandatory.
  Supersession detection is topical and mostly ambiguous by design. Contradiction detection is the NB-3 lexicon/number heuristic (no semantic contradiction).
- No import resume (rollback instead); 1M messages not run; the upload/preview path holds the archive in memory.
- SESSION_ONLY still touches disk during the session (guarantee = absence after restart).
- Unified retrieval merges by round-robin (no cross-source relevance calibration); approved candidates are not used in answers yet (NB-5).
- Provider-name attribution follows structure only; a renamed/edited export can be mislabelled `UNKNOWN`, never the reverse.
- `client.ts` / `App.tsx` also hold the uncommitted YouTube-Shorts changes from an earlier mission; NB-3 Google-Fonts removal is also uncommitted.
