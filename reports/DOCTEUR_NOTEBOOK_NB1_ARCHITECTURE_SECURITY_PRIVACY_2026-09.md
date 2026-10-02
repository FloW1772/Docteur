# DOCTEUR NOTEBOOK — NB-1: ARCHITECTURE + SECURITY + PRIVACY + RAG DESIGN AUDIT

Status: **AUDIT / ARCHITECTURE ONLY — no implementation**
Date: 2026-09-29

This is a design document. No dependency was installed, no functional code
was modified, no frozen module was touched, no cloud provider connection was
created, no model was downloaded. The only file this mission produced is
this report.

## 0. Baseline

`git status --short` / `git diff --stat` / `git diff --name-only` at mission
start: clean tree, 0 uncommitted changes.

Frozen modules confirmed and **not touched**: MAÎTRE V1, Observateur V1,
OMEGA V1, OMEGA V2 (Device Fabric-integrated outbound), RASSILON V1, Device
Fabric V1, Device Fabric V2 (FINAL/CERTIFIED/FROZEN per
`reports/DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md`), the certified
Local AI layer.

**This mission does not start from zero.** A working local Notebook/RAG
feature already exists (MASTER Phase 5 and 5B, 2026-09-15,
`reports/MASTER_PHASE_5_NOTEBOOK.md` / `MASTER_PHASE_5B_NOTEBOOKLM_FUTURE.md`),
plus a separate Adaptive Memory system (Phase 3,
`reports/MASTER_PHASE_3_ADAPTIVE_MEMORY.md`). §1.1 below states exactly how
NB-1 relates to what already runs today. Everything in this document is
scoped as **NB-2 and later** work — an evolution, not a replacement, of a
system that is live, tested (178/178 at Phase 5B), and already
strict-local-by-construction.

### 0.1 What already exists today (read, not modified)

| Piece | File(s) | What it does now |
|---|---|---|
| Notebook core | `cortex-server/src/lib/notebook.js` (176 lines) | Notebook = named collection of *references* to existing LanceDB `neurons` rows. Privacy = OR of all sources (most-restrictive-wins), recomputed on every add/remove. Retrieval scoped to only the notebook's source ids (`searchNeuronsByIds`, LanceDB `.where()` id-list pushdown) — never the whole neuron store. Structured `[N]` citations, never fabricated (an out-of-range index is silently dropped). Cached level-1 global summary. |
| Notebook routes | `cortex-server/src/routes/notebook.js` (258 lines) | CRUD, `POST /ask`, `GET /summary`, manual NotebookLM-export. **Imports zero cloud provider** — confirmed by reading every import. |
| Notebook schema | `sqlite.js`: `notebooks`, `notebook_sources`, `notebook_summaries` | Additive tables. `notebook_sources.source_id` references a LanceDB neuron id — never a content copy. Deleting a source/notebook never deletes the underlying neuron. |
| NotebookLM (Google) stub | `cortex-server/src/lib/notebook-provider.js`, `cortex-server/src/routes/notebooklm.js` | `NOTEBOOK_PROVIDERS = { local: available, notebooklm_future: unavailable }`. Key stored via existing DPAPI `secret-store.js`. **Zero `fetch()` in the file** (verified). Fully decoupled from `routes/notebook.js` — a configured key changes nothing about local Q&A. |
| Adaptive Memory | `cortex-server/src/lib/memory.js` (229 lines), tables `preference_facts` (long-term) / `episodic_memories` | 3 tiers: session, episodic, long-term. 100% local, rule-based extraction (`isWorthRemembering`); an `extractWithOllama` hook exists but is wired nowhere yet. Jaccard dedup (≥72% merge). Budget-bounded selection (3/5/8 items), scored (relevance/importance/recency/frequency) — **keyword match only, no embeddings** (documented limitation). Privacy propagates via `privacyFromSource()`, never downgradable. |
| Vector store | `cortex-server/src/lib/lancedb.js` (338 lines) | Single table `neurons` (`id, kind, title, content, content_preview, metadata, vector, created_at, updated_at`). `mergeInsert` upserts. `needsCompaction()` at 1000 fragments or disk-bloat threshold. |
| Embedding provider | `lib/ollama.js` `embedText()`, model `nomic-embed-text` | Single shared local-only embedding path used identically by chat, Notebook, RASSILON, Device Fabric. Hard allowlist (`EMBEDDING_MODEL_ALLOWLIST = ['nomic-embed-text']`) enforced in `rassilon-job-schema.js` and mirrored in `device-fabric-routing.js`. |
| Cloud boundary (soft) | `cortex-server/src/lib/strict-local.js` | `isStrictLocalMode()` reads a SQLite setting; `assertCloudAllowed()` returns a 503 if blocked. User-facing opt-out toggle. |
| Cloud boundary (hard) | `cortex-server/src/lib/privacy-guard.js` | **The real technical backstop.** `markPrivate(text)` prepends a Unicode sentinel to private content when building any outbound message. Every cloud provider's `complete()` calls `guardCloudCall()` before any HTTP request; if the sentinel appears anywhere in the stringified payload, it throws `PrivacyViolationError` and logs an incident (`insertPrivacyViolation`) — no content logged. Fires even if a routing bug tries to send private content anyway. |
| PDF parsing | `pdf-parse@2.4.5` (existing dep), used in `routes/cv-import.js` | 10 MB cap, hyphenation/page-number cleanup, scanned-PDF heuristic (`MIN_TEXT_CHARS_PER_PAGE=40`), explicit "never logged, no temp files" note. |
| HTML parsing/sanitizing | `jsdom@29.1.1` + `@mozilla/readability@0.6.0` (existing deps) | `deep-capture.js` (Readability extraction), `cyber-crawler.js` (jsdom **without** `runScripts`), `kiwix-sanitize.js` (allowlist-tag sanitizer: strips script/style/iframe/`on*` handlers, proxies remote images, rewrites internal links). |
| DOCX parsing | **absent** | No DOCX library is currently a dependency. Net-new if NB-2+ needs it. |
| Secret redaction | `logger.js` (own credentials), `cyber-redact.js` (audited-target secrets, stricter, JWT-shape aware), `video-audio-download.js`'s `redactDownloadLog` | Deterministic, pattern-based, line-oriented. No AI-based redaction anywhere. |
| Prompt-injection defense | **no dedicated module** | `external-agent-policy.js`'s `sanitize()` + credential-path deny-check is a *prompt exfiltration* guard for coding-agent prompts, not a generic LLM prompt-injection classifier. This is a genuine gap NB-1 must design for net-new (§10). |
| Observateur | `cortex-server/src/lib/monitor-service.js` and siblings | Passive local system monitoring (connections/processes). Read-only signal producer; never takes action. |
| "Agency" | **no literal module** | Closest existing precedent is MAÎTRE (`maitre-orchestrator.js`): ingest signals → correlate → **propose → approve → execute**, with the ingestion/correlation pass explicitly "no system action, no Ollama, no cloud." This propose/approve/execute gate is the pattern any future Notebook-reading agent must follow before it can act (§34). |
| RASSILON embedding batch | `rassilon-embedding.js`, job type `EMBEDDING_BATCH` in `rassilon-job-schema.js` | Already exists (not `SAFE_EMBEDDING_BATCH` — the job type is literally `EMBEDDING_BATCH`). Local-only Ollama adapter, same model allowlist. A future bulk-reembedding need already has a place to plug into (§36). |

### 0.2 What NB-1 is, precisely

NB-1 is the architecture for the **next evolution** of this system: moving
from "Notebook references existing neurons" to "Notebook can ingest raw
documents directly (PDF/DOCX/HTML/TXT/MD), track them with real
provenance/versioning, chunk-and-embed them with explicit model versioning,
and eventually import AI conversation histories as a distinct, carefully
bounded source type" — while preserving every guarantee the existing system
already proved (strict local by default, scoped retrieval, never-fabricated
citations, privacy never downgradable, no automatic tool execution).

## 1. Product definition

DOCTEUR NOTEBOOK is a native Docteur engine for personal knowledge, search,
RAG, citation, notes, and synthesis over sources the user explicitly adds.

It is **not**:
- a replacement for the LLM,
- automatic fine-tuning/training of the model,
- unlimited opaque memory,
- a system that treats everything a past AI wrote as verified fact,
- a system requiring the cloud.

### 1.1 Conceptual pipeline

```
USER SOURCES
    ↓
INGESTION
    ↓
NORMALIZATION
    ↓
SECURITY FILTER
    ↓
DOCUMENT / CHUNK STORE
    ↓
SEARCH
  ├─ FTS
  └─ VECTOR
    ↓
RETRIEVAL
    ↓
RERANK / FILTER
    ↓
CITATION PACK
    ↓
LLM
    ↓
ANSWER + SOURCES
```

Today's Notebook already implements the right half of this pipeline
(STORE → SEARCH(vector-only) → RETRIEVAL → CITATION PACK-equivalent → LLM →
ANSWER+SOURCES) over neurons. NB-2+ fills in INGESTION, NORMALIZATION,
SECURITY FILTER, and FTS as first-class stages for raw documents, and adds a
real chunk-level store instead of read-time re-chunking.

## 2. Privacy modes

Three modes, exactly as specified:

| Mode | Default | Guarantee |
|---|---|---|
| **STRICT LOCAL** | **yes** | 0 document upload, 0 chunk upload, 0 embedding cloud call, 0 cloud inference, 0 cloud telemetry tied to Notebook |
| **HYBRID** | opt-in | explicit opt-in; UI must visibly show exactly what leaves the machine before it leaves |
| **GEMINI CLOUD** | opt-in | explicit opt-in; never auto-enabled by any code path |

**Architecture decision**: reuse the existing two-layer boundary exactly as
built, never invent a third mechanism.
- `strict-local.js` (`assertCloudAllowed`) is the **mode toggle** — what the
  user asked for.
- `privacy-guard.js` (`markPrivate`/`guardCloudCall`) is the **hard
  backstop** — what actually prevents an accidental leak even if a future
  Notebook routing bug tries to call a cloud provider with private context.
  Every future Notebook chunk that carries `trustLevel`/`privacyLevel`
  implying local-only **must** be sentinel-marked before it can enter any
  message construction path, exactly like private neuron content is today.

This is not a new design — it is applying the Phase 1-certified mechanism
(already load-bearing for chat, memory, and every provider) to a new content
type. **0 new cryptographic or gating primitive is proposed.**

## 3. Data model

Minimum entities, as specified, with a decision on each relative to what
already exists:

| Entity | Status |
|---|---|
| `Notebook` | **exists** (`notebooks` table) — extend, don't replace |
| `Source` | **exists in spirit** (`notebook_sources`, currently `source_type='neuron'` only) — extend `source_type` to a real enum (§3.1) |
| `Document` | **new** — today "document" and "neuron" are conflated; NB-2+ needs a document concept independent of whether it was ever indexed as a neuron |
| `DocumentVersion` | **new** (§16) |
| `Chunk` | **new as a stored entity** — today chunking happens at read time from neuron content (`chunkSourceContent`), never persisted. Persisting becomes necessary once Document ≠ Neuron and once per-chunk embeddings are wanted (§17.1) |
| `Embedding` | **exists implicitly** (one vector per LanceDB neuron row) — NB-2+ needs one embedding per *chunk*, not per document, with explicit versioning (§19) |
| `Citation` | **exists** (`extractCitations()`) — already structured, already provenance-traced; extend to carry `trustLevel` (§9) |
| `Conversation` | **exists** (`conversations`/`conversation_messages`, reused by Adaptive Memory) |
| `Message` | **exists** (`conversation_messages`) |
| `Artifact` | **new** — Notebook currently produces only text answers + a level-1 summary; a generic Artifact concept (flashcards, timeline, comparison table — the Phase 5 "TOOLS" tab already names these as honestly-not-implemented) needs its own row type before any of those tools can be built |
| `ImportJob` | **new** — needed once ingestion is asynchronous/bulk (PDF parsing, AI-history distillation) rather than the current synchronous single-neuron-reference add |
| `SourcePermission` | **new** — today all Notebook sources are equally readable by the owner; not yet relevant until multi-notebook/cross-notebook or Agency read access exists (§34, §52) |
| `RetentionPolicy` | **new** (§26) |
| `ProvenanceRecord` | **new**, but the *pattern* already exists — `notebook_sources.provenance` is a first pass at this; formalize it as its own append-only record rather than a mutable column |

### 3.1 `Source` fields (as specified)

```
sourceId          — stable id, format tbd (mirror fdev-/ov2h- style prefixing
                     used elsewhere in Docteur, e.g. "nsrc-<uuid>")
notebookId
type              — enum: NEURON_REF | DOCUMENT | WEB_IMPORT | AI_HISTORY_EXPORT
                     | OBSERVATEUR_PROMOTED | CONNECTOR
origin             — human-readable: "local file", "web import", "ChatGPT export", …
canonicalUri       — original location if one exists (URL, original file path at
                     import time) — never re-fetched automatically, purely
                     informational + for dedup/citation display
localPath          — where Docteur stores its own copy, if it stores one at all
                     (raw document store, §12); null for NEURON_REF (no copy,
                     reference only — preserves the current, already-correct
                     Phase 5 behavior for that type)
importedAt / updatedAt
hash               — exact-content hash (§15)
mimeType
size
language           — best-effort detected, never assumed
trustLevel         — see §9
privacyLevel       — never lower than the strictest of its Notebook's other
                     sources once aggregated (§2, existing computeNotebookPrivacy
                     logic extends unchanged)
licenseMetadata    — free text / structured, honesty-only (Docteur does not
                     enforce license compliance, only records what's known)
status             — PENDING | INDEXING | READY | FAILED | DELETED
```

## 4. Chunk model

As specified:

```
chunkId
sourceId
documentVersion    — which DocumentVersion this chunk was derived from
text
startOffset / endOffset
pageNumber         — when available (PDF)
headingPath        — e.g. ["Chapter 2", "2.3 Setup"] for Markdown/HTML/DOCX
hash               — for exact-chunk dedup independent of document-level hash
embeddingModel
embeddingVersion
createdAt
```

Chunking algorithm: reuse `chunkText()` from `cortex-server/src/lib/chunking.js`
unchanged as the baseline splitter (paragraph-boundary, hard-split fallback,
already shared between `corpus.js` and `notebook.js`) — extend it to also
record `startOffset`/`endOffset`/`headingPath` as it walks the document,
rather than replacing it. **0 new chunking algorithm proposed for NB-1**;
the existing one is simple, deterministic, and already proven at the scale
tested (100 sources, <2s in Phase 5).

Every citation must resolve `chunkId → sourceId → Document → canonical
location` — this chain already exists end-to-end for neurons
(`extractCitations` → `chunkId` → `sourceId` → `sourceTitle`); extending it
to raw documents only requires `Chunk` to carry the same fields, not a new
resolution mechanism.

## 5. Citation-first: fact categories

A Notebook answer must distinguish:

| Category | Meaning |
|---|---|
| `FACT_FROM_SOURCE` | directly supported by a retrieved chunk, cited |
| `MODEL_INFERENCE` | the LLM's own reasoning, not directly stated in any chunk |
| `USER_ASSERTION` | something the user stated in the current conversation, not a Notebook source |
| `PAST_AI_ASSERTION` | content originating from an imported AI-history source (§6) — **never auto-promoted to `FACT_FROM_SOURCE`** |
| `UNKNOWN` | no support found; the answer contract (§23) requires saying so explicitly rather than guessing |

This is the single most important boundary in this whole design: **a past
AI response is a citable artifact, never a verified fact, purely because it
exists in an import.** The existing `[N]` citation mechanism already
supports "cite what's actually there, never fabricate" — NB-2+ needs the
prompt/answer contract to additionally tag *which kind* of thing chunk `[N]`
is, so the model (and the UI) can render `PAST_AI_ASSERTION` visibly
differently from `FACT_FROM_SOURCE`.

## 6–7. AI histories as future sources, and their distillation

Future source types: ChatGPT export, Gemini export, Claude export, other
structured exports. **Not implemented in NB-1; design only.**

### 6.1 Content-type separation within one conversation export

A raw export is not one text blob. It must be parsed into:

```
USER_MESSAGE | AI_RESPONSE | TOOL_RESULT | ATTACHMENT | SYSTEM_METADATA | UNKNOWN
```

Each becomes its own `Message`-shaped row (reusing the existing
`conversations`/`conversation_messages` tables' shape conceptually, but as
**imported, read-only, provenance-tagged** rows — never merged into the
live chat history tables the user is actively using today). Merging them
into one free-text blob (as a naive "dump the whole export as one document"
importer would) destroys exactly the distinction §5 depends on — an
`AI_RESPONSE` that made something up looks identical to a `USER_MESSAGE`
stating a fact, once flattened.

### 6.2 Distillation pipeline (design only, not built)

```
raw export
  → parser                     (format-specific: ChatGPT JSON, Gemini export
                                 format, Claude export format, …)
  → normalization               (into the Message content-type enum above)
  → deduplication                (same conversation exported twice, edited-and-
                                  regenerated turns)
  → secret scanning              (§27 — before anything else touches the text)
  → conversation reconstruction  (thread order, branches if the source format
                                  has them)
  → source attribution            (every extracted item keeps a pointer back to
                                  its exact position in the original export)
  → semantic extraction          (optional, LLM-assisted, LOCAL ONLY per §2 —
                                  decisions / project facts / preferences /
                                  technical discoveries / requirements / open
                                  questions / resolved questions / snippets /
                                  architecture decisions)
  → optional human review        (user confirms before anything extracted is
                                  promoted anywhere else, mirroring the existing
                                  memory-suggestion confirm pattern:
                                  `[[MEMOIRE: ...]]` → explicit
                                  POST /chat/preferences today)
  → Notebook indexing
```

Every extracted item retains: source export id, exact turn/message id it
came from, extraction method (rule vs LLM), and a `PAST_AI_ASSERTION` /
`USER_ASSERTION` tag per §5. Nothing in this pipeline auto-writes to
Adaptive Memory's long-term tier or to a future Global Memory (§53-54) — it
only reaches the AI-history Notebook itself.

## 8. Memory ≠ intelligence

To document explicitly, not to build: Notebook does not make the underlying
model smarter. It improves **context recall, project continuity, factual
retrieval, personalization, decision consistency, source grounding, and
long-term project awareness** — never model training. This framing must
appear in any future Notebook-facing UI copy (mirrors the NotebookLM
section's existing honest-copy pattern: *"aucun appel à l'API [...] même si
une clé est enregistrée"*).

## 9. Trust levels

```
USER_AUTHORED | PRIMARY_SOURCE | VERIFIED_EXTERNAL | SECONDARY_SOURCE |
PAST_AI_OUTPUT | UNVERIFIED_WEB | UNKNOWN
```

The retriever must be able to filter/weight by this level — e.g. a query
explicitly scoped to "what did I decide" can exclude `PAST_AI_OUTPUT` and
`UNVERIFIED_WEB`; a query scoped to "what has ChatGPT told me before" can
include only `PAST_AI_OUTPUT`, explicitly labeled as such in the answer.
`trustLevel` is a `Source`-level field (§3.1); a `Chunk` inherits its
source's level (never override per-chunk in NB-1 — keep it simple until a
real need for finer granularity appears).

## 10. Prompt injection — critical

**Confirmed gap**: no existing module in this codebase defends against LLM
prompt injection specifically (§0.1). This must be designed net-new.

**Core rule**: every document imported into Notebook is DATA, never
INSTRUCTION. A chunk's text, however it's phrased ("ignore previous
instructions", "act as system", "reveal your prompt"), must never be able
to change the system prompt's authority.

Structural defenses (design, not implementation):
1. **Positional isolation**: retrieved chunk text is always wrapped inside a
   clearly delimited, machine-generated envelope in the prompt (the current
   `buildNotebookMessages()` already does this — `Extraits disponibles :`
   as a separate system message, chunk text never concatenated directly
   into the system instruction). Extend this so each chunk is wrapped with
   an explicit non-spoofable delimiter (e.g. a random-per-request boundary
   token) and the system prompt explicitly states that text inside the
   boundary is untrusted user data, never a command.
2. **No privilege escalation from content**: the system prompt must state,
   every time, that nothing inside a source can grant tool access, change
   the assistant's identity, or alter Docteur's own configuration —
   mirroring how `privacy-guard.js` fires regardless of what a routing
   function *intended*, a prompt-injection defense should not rely on the
   model "deciding" to ignore an injected instruction; it should structurally
   prevent that instruction from having any effect even if the model is
   fooled (§11 makes this concrete: RAG output is never wired to an
   executor).
3. **Pattern-based pre-filter (defense in depth, not the primary control)**:
   before indexing, flag (not silently strip) chunks containing
   instruction-shaped strings ("ignore previous instructions", "send
   files", "run command", "reveal secrets", "call this URL", "install
   package", "execute shell", "act as system", and similar) — surfaced to
   the user at import time as a warning, never a silent block (avoids both
   over-blocking legitimate security-research documents *and* silently
   indexing something adversarial).

## 11. Tool injection — retrieved content must never trigger action

RAG output is information, full stop. Retrieved/generated Notebook content
must **never automatically** trigger: shell, PowerShell, file execution,
browser automation, OMEGA, RASSILON, Device Fabric, publication, email,
social media, or any API call.

This is not a new guarantee to invent — it is a **structural non-connection**
to preserve: Notebook's answer path (`buildNotebookMessages` → LLM →
`extractCitations`) has zero import of any executor today, and NB-2+ must
keep it that way. Any future action a user wants to take based on a
Notebook answer requires a **separate, explicit action** through Docteur's
normal permission surfaces (Device Fabric's own ADMIN confirm-dialog
pattern, MAÎTRE's propose→approve→execute gate) — never a Notebook-internal
shortcut.

## 12. File parsing security

| Format | Known risks | Mitigation direction |
|---|---|---|
| PDF | parser exploits, oversized/malformed files, embedded JS/launch actions | Reuse `pdf-parse` pattern from `cv-import.js` unchanged: hard size cap, no temp files, text-only extraction (never render/execute embedded content), scanned-doc heuristic to avoid silently indexing an empty OCR-needed doc as "successfully imported" |
| DOCX | zip-bomb (DOCX is a zip), macro content (VBA), embedded OLE objects, XML entity expansion | **No library present yet** — any future choice must be an XML/zip-safe extractor with entity-expansion disabled and macro content never executed or even parsed for execution, only skipped |
| HTML | script/iframe/embedded active content, remote image/resource loading (tracking pixels, SSRF-shaped requests), oversized documents | Reuse `kiwix-sanitize.js`'s allowlist-tag approach: strip `<script>`/`<style>`/`<iframe>`/`on*` attributes, never fetch remote resources automatically (§13), and use `jsdom` **without** `runScripts` exactly as `cyber-crawler.js` already does |
| Markdown | link/image-based exfiltration if rendered with remote fetch, embedded HTML in Markdown | Render through the existing `marked` dependency in a mode that does not auto-fetch remote resources; treat embedded raw HTML the same as §13 |
| TXT | none structural, but still needs size/encoding limits | size cap, encoding detection, reject/flag null-byte-laden or non-text binary masquerading as `.txt` |
| JSON | huge/deeply-nested payloads (stack exhaustion), prototype pollution if naively `eval`'d (never `eval`, always `JSON.parse`) | size cap, depth cap, `JSON.parse` only, never dynamic code evaluation |
| ZIP export (AI history) | zip bombs, path traversal on extraction, oversized archive, huge file count | Reuse the existing `7zip-bin`/`node-7z` dependency's safe-extraction mode; enforce **compressed-size cap, decompressed-size cap, file-count cap, and per-file path validation (reject `..`/absolute paths) before any extraction**, not after |

General controls across all formats: **size limits, file-count limits,
timeouts, memory limits**, and safe (non-interpreting) parsers as the
default; sandboxing is a "if a future format genuinely requires executing
untrusted code to parse it, don't add that format" decision rather than a
"build a sandbox" one — NB-1 recommends avoiding any parser that requires
code execution rather than building isolation infrastructure for it.

## 13. HTML / web import

Never execute JavaScript, iframes, or embedded active content — this
matches `cyber-crawler.js`'s existing `jsdom` (no `runScripts`) default
exactly; extend that same default to Notebook's HTML import path rather
than introducing a second HTML-handling code path with different defaults.
Remote resources (images, fonts, stylesheets) are **OFF by default** —
mirrors `kiwix-sanitize.js`'s existing image-proxying pattern (never
fetch the original remote URL directly; either proxy through a controlled
endpoint or strip entirely for imported documents, since there's no kiwix-
style local archive to proxy through here).

## 14. PDF pipeline

```
PDF → text extraction (pdf-parse, existing dependency, reused unchanged)
OCR only if the scanned-PDF heuristic fires (existing MIN_TEXT_CHARS_PER_PAGE
  pattern from cv-import.js) — OCR is a separate, explicit, heavier step,
  never silently invoked on every PDF
```

Preserve on ingest: page references (so a citation can say "page 12"),
document title (from PDF metadata, falling back to filename), other PDF
metadata (author, creation date — informational only, never trusted),
source hash (§15). `Chunk.pageNumber` (§4) is populated directly from this
extraction step — never inferred after the fact from character offsets
alone, since `pdf-parse`'s page-boundary information is available at
extraction time and would be lost if chunking happened on a flattened
whole-document string without carrying page boundaries through.

## 15. Duplicates

Three layers, from cheapest/strictest to most expensive/fuzziest:

1. **Exact hash dedup** — `sourceId` derived content hash (§3.1's `hash`
   field); re-importing byte-identical content is a no-op (surfaced to the
   user as "already imported", not silently ignored).
2. **Normalized hash dedup** — hash of whitespace/encoding-normalized text,
   catches "same PDF re-exported with different metadata/line-endings."
3. **Near-duplicate detection** — reuse the existing Jaccard-similarity
   pattern already proven in `memory.js` (≥72% merge threshold, tested at
   100-near-identical → 1) rather than inventing a new similarity metric;
   apply it at the Document level for import-time warning ("this looks very
   similar to an existing source — import as a new version instead?"),
   feeding directly into §16's versioning decision rather than silently
   creating a duplicate Source row.

## 16. Document versions

A changed file never silently overwrites the old version. A new
`DocumentVersion` row is created; the prior version's chunks/embeddings
remain queryable, and every stored `Chunk.documentVersion` field (§4)
lets a past answer's citations be traced to the exact version that
supported them — even after the document changes again. This mirrors the
already-proven `savePageToStoreIfNewer()` pattern (§0.1's SQLite findings)
in spirit — never overwrite blind — but Notebook needs an explicit version
chain (not just "reject a stale write") because past answers must remain
citable against the version they were actually generated from.

## 17. Search architecture

### 17.1 FTS vs vector vs hybrid — verdict

**Hybrid: SQLite FTS5 + local embeddings + hybrid ranking.** This is the
mission's own stated preference, and it is the right one for this system:

- FTS5 gives exact-term/keyword recall that a vector-only system misses
  (proper nouns, code identifiers, exact error messages — exactly the kind
  of query a technical Notebook needs) and it works **even with zero
  embedding model available**, satisfying the requirement that the system
  degrade gracefully rather than go fully dark if Ollama is down.
- Vector search (already working today via LanceDB) gives semantic recall
  FTS5 structurally cannot.
- Hybrid ranking (reciprocal rank fusion or a simple weighted-score merge
  of the two result sets) is a well-understood, cheap technique — no new
  infrastructure, just a merge function over two already-planned result
  lists.

**Fallback behavior**: if `embedText()` fails or Ollama is unavailable,
retrieval must fall back to **FTS5-only**, not fail closed entirely — this
is a new graceful-degradation requirement (todays's Notebook has no
FTS layer at all, so this doesn't regress anything, it adds resilience that
doesn't exist yet).

### 17.2 What changes vs today

Today's Notebook has vector search only (via neurons' existing embeddings).
NB-2+ adds FTS5 as a genuinely new capability, not a replacement.

## 18. Embedding providers — local options, audited conceptually

**Nothing downloaded, nothing installed — this is a comparison of options
already documented or already present as dependencies.**

| Provider | Already present? | Notes |
|---|---|---|
| Ollama + `nomic-embed-text` | **yes — the only one currently wired anywhere in Docteur** (chat, Notebook, RASSILON, Device Fabric all allowlist exactly this model) | Multilingual quality: adequate for general text, not specialized. Dimension: 768 (nomic-embed-text-v1.5 default). Speed: acceptable on CPU for the scale targets in §45; GPU accelerates but isn't required. **Recommendation: keep this as the sole default for NB-2/NB-3 — do not add a second embedding provider until a concrete need (e.g. a language nomic-embed-text handles poorly) is identified.** |
| llama.cpp (GGUF embedding models) | no | Would require a new runtime dependency and model format the project doesn't currently manage; Ollama already wraps this need |
| ONNX (via onnxruntime-node or similar) | no | Would add a second inference runtime alongside Ollama for no clear benefit given Ollama already serves this role |
| sentence-transformers (Python) | no | Would require a Python runtime dependency in a primarily Node.js backend — against §50's dependency-budget preference |

**Verdict: no new embedding provider for NB-1-scoped work.** Ollama +
`nomic-embed-text` remains the single embedding path, consistent with every
other subsystem in Docteur today.

## 19. Embedding versioning

Never assume an embedding stays comparable after a model change. Every
stored embedding (whether at the neuron level today or the chunk level in
NB-2+) must record:

```
provider        — e.g. "ollama"
model           — e.g. "nomic-embed-text"
modelVersion    — tag/digest if available, else the string used at embed
                  time (mirrors the existing name:tag/name@digest allowlist
                  pattern already enforced in rassilon-job-schema.js)
dimension
normalization   — whether/how the vector was normalized before storage
createdAt
```

A retrieval query embedded with a different model/version than a stored
chunk's embedding must either be flagged as **potentially degraded** or
(safer default) that chunk excluded from vector-search results until
re-embedded — never silently compared as if compatible. This is a new
discipline vs today's system (which has never changed embedding model, so
this risk hasn't materialized yet) and must be designed before it does.

## 20. Reranking

Options evaluated:

| Option | STRICT LOCAL compatible? | Verdict |
|---|---|---|
| No reranker (raw vector/FTS score) | yes | simplest, acceptable starting point for NB-2 |
| BM25 (FTS5's built-in) + vector score, merged | yes | this **is** §17.1's hybrid ranking — recommended default |
| Small local cross-encoder | yes, if genuinely local (no cloud call) | worth evaluating in NB-3 once hybrid retrieval's actual result quality is measured against real usage — do not add speculatively |
| LLM reranking | yes, if using the local Ollama model | most expensive; only worth it if §21's context budget shows top-k quality is still insufficient after hybrid ranking |

**Verdict**: start with hybrid BM25+vector score merging (§17.1), no
separate reranker model, for NB-2. STRICT LOCAL must remain possible at
every tier — nothing above requires a cloud call.

## 21. Context budget

Never inject an entire Notebook into context — this guarantee already
exists today (`retrieveForQuestion`'s `topK`, `MAX_CONTEXT_CHARS_PER_CHUNK`
truncation) and must be preserved, extended with:

- **top-k retrieval**: unchanged concept, tune per hybrid-ranking output.
- **token budget**: today's system caps by character count per chunk; a
  token-aware budget (mirroring `memory.js`'s `selectMemoriesForBudget`
  budget-tiers pattern: low/normal/extended) is a natural extension once
  chunk count and source diversity both need to be budgeted jointly, not
  just per-chunk truncation.
- **diversity**: avoid returning 6 chunks from the same document when 3
  different documents are all relevant — a simple per-source cap within
  the top-k selection (e.g. max 2-3 chunks per source before moving to the
  next-best source) is enough; no need for a sophisticated diversity
  algorithm at NB-2 scale.
- **duplicate suppression**: near-identical chunks (possible after §16
  versioning keeps old versions queryable) should not both appear in one
  retrieval — dedup at the chunk-hash level (§15) before final ranking.
- **source balance**: related to diversity — ensure a single
  disproportionately-large source doesn't dominate every retrieval by
  sheer chunk-count.

## 22. Citation pack

Before every LLM call, construct an explicit object:

```
{
  query,
  retrievedChunks: [...],       // exactly what was selected after §21's budget
  sourceMetadata: [...],         // title, trustLevel, type, per source referenced
  citationIds: [...],            // the [N] → chunkId mapping, precomputed
  trustLevels: [...],
  tokenBudget: { used, max },
}
```

This formalizes what `buildNotebookMessages()`/`extractCitations()` already
do implicitly (build a `[N]`-indexed context, then map used indices back)
into an explicit, loggable, testable intermediate object — makes citation
correctness independently testable without needing a real LLM call, and
gives the answer contract (§23) something concrete to validate against.
**The model never invents a citation** — this guarantee already holds today
(`extractCitations` only accepts in-range indices) and carries forward
unchanged.

## 23. Answer contract

```
{
  answer: string,
  citations: Citation[],           // existing shape, extended with trustLevel
  uncertainties: string[],          // new — explicit "I don't know" markers
  sourceConflicts: Conflict[],      // new — see §24
  retrievalMetadata?: {...},        // optional, for debugging/observability
}
```

If no source supports a claim, the answer must say `UNKNOWN` or clearly
mark the statement as `MODEL_INFERENCE` (§5) — never present an
unsupported claim as `FACT_FROM_SOURCE`. This is a prompt-engineering and
post-processing discipline extending the existing system prompt's already-
correct instruction ("si l'information n'est pas dans les extraits, dis-le
clairement") into a structured, checkable field rather than free prose only.

## 24. Contradictions

If two sources disagree, **never silently merge**. Display:

```
Source A (title, date, trustLevel) says X
Source B (title, date, trustLevel) says Y
```

This mirrors `memory.js`'s existing decision to never merge contradicting
memories (e.g. "j'aime le café" vs "je déteste le café" — resolved by
recency-weighted selection, not fusion) — Notebook's contradiction handling
should surface both, not silently prefer one, since a Notebook answer's
job is grounding, and hiding a contradiction is the opposite of that.

## 25. Deletion

Deleting a Source must cascade cleanly:

- delete the Source row,
- delete its Chunks,
- delete its Embeddings,
- delete/invalidate Citations that derived from it (existing answers that
  cited it become citations-to-a-deleted-source — mark, don't silently
  leave dangling),
- clear any cached retrieval state that assumed the source existed
  (mirrors `notebook_summaries`' existing invalidate-on-source-change
  pattern).

What remains in logs must be documented per-deployment: audit/event logs
(mirroring Device Fabric's own audit pattern — ids and enum event types
only, never content) may retain a "source X was deleted at time Y" record
even after the source itself is gone — this is intentional (audit trail)
and must be disclosed to the user, not hidden.

## 26. Retention

```
KEEP           — default, no automatic deletion
DELETE_AFTER   — a duration; automatic cleanup once past
SESSION_ONLY    — never persisted past the current session; for sensitive
                  one-off imports (e.g. a document the user wants Notebook
                  to reason about right now but not keep)
MANUAL          — user must explicitly delete; distinguishes from KEEP only
                  in UI framing (KEEP = "no policy set", MANUAL = "user
                  explicitly chose never-auto-delete")
```

`SESSION_ONLY` is the answer to "sensitive content the user wants used but
not stored" — must be enforced at the storage layer (never written to
SQLite/LanceDB at all, kept in-process only) rather than "written then
best-effort deleted," since the latter leaves a window where a crash could
leave it persisted.

## 27. Secret scanning

Before indexing, detect: passwords, API keys, tokens, private keys,
cookies, connection strings, credentials.

**Reuse `cyber-redact.js`'s pattern directly** rather than building a new
detector — it already handles Authorization/Cookie/API-key/token/password/
JWT-shape patterns with attribute-name preservation, and it is the stricter
of the two existing redaction modules (vs `logger.js`, which is scoped to
Docteur's own credentials specifically).

Three response options per finding, as specified:
- **BLOCK** — refuse to index the document until resolved (safest default
  for anything with `privacyLevel` implying cloud-eligible)
- **REDACT** — replace the detected secret with a placeholder, index the
  rest (useful for e.g. a long document with one incidentally-included API
  key)
- **USER_CONFIRM** — surface the finding, let the user decide per-document

**Hard rule, non-negotiable**: a detected secret is **never** sent to a
cloud provider without explicit user consent — this is not a new
invention, it's `privacy-guard.js`'s existing `markPrivate`/`guardCloudCall`
mechanism (§2) applied to secret-scan hits specifically: any chunk with a
secret finding gets sentinel-marked exactly like private neuron content
does today, so the existing hard backstop covers it even if a future
routing bug tries to send it anyway.

## 28. Encryption at rest

SQLite (Notebook metadata tables) and the vector store (LanceDB) are
currently unencrypted at rest, consistent with the rest of Docteur's local
storage (the only encrypted-at-rest data today is DPAPI-protected secrets
via `secret-store.js` — API keys, not document content).

**Evaluation, not a recommendation to build**: full-database encryption at
rest would need either SQLCipher (a real, audited dependency — not a
homegrown scheme) or OS-level disk encryption (BitLocker on Windows,
already outside Docteur's control and arguably the more appropriate layer
for "the whole machine is protected if stolen," rather than encrypting one
app's database in isolation). **Recommendation: rely on OS-level disk
encryption as the realistic baseline; do not build a Docteur-specific
encryption-at-rest layer for NB-1-scoped work** — this avoids exactly the
"invent a homegrown cryptographic system" pitfall the mission explicitly
warns against. If sensitive-Notebook-specific encryption is ever justified,
SQLCipher (an existing, mature, audited SQLite extension) is the only
acceptable path — never a custom cipher.

## 29. Single DB vs separate Notebook DB — verdict

**Extend the existing single Docteur SQLite database with additional
Notebook tables — do not create a separate Notebook database file.**

| Criterion | Single DB (current) | Separate DB |
|---|---|---|
| Security isolation | Weaker (shared file) but Docteur has no cross-feature SQL injection surface today to exploit this; Notebook tables would follow the same prepared-statement discipline as every other table | Stronger in theory, but Docteur's actual attack surface doesn't benefit meaningfully — the whole app already trusts one local SQLite file |
| Migration risk | Lower — one migration path, already proven (Device Fabric V2's own migration test is a template: additive columns/tables, never destructive) | Higher — two schemas to keep in sync, two migration paths, cross-DB foreign-key-equivalent references become string-only with no referential integrity check at all |
| Backup | Simpler — one file to back up | More files to coordinate, easy to back up one and not the other and end up with an inconsistent pair |
| Portability | Simpler — the existing backup/export tooling already covers one file | Would need new tooling |
| Locking | SQLite's single-writer model already applies today across all features; Notebook adds write volume but not a new contention pattern | A separate DB doesn't inherently reduce lock contention if both are still accessed by the same single Node.js process |
| Performance | Adequate at the scale targets in §45 (SQLite handles millions of rows fine for this access pattern) | No meaningful performance benefit at this scale — separate-DB benefits mostly appear at a scale far beyond §45's targets |

**Verdict: single DB.** This also matches what Phase 5 already did
(additive `notebooks`/`notebook_sources`/`notebook_summaries` tables in the
existing `sqlite.js`) — NB-2+ continues that pattern for `documents`,
`document_versions`, `chunks`, `provenance_records`, etc., rather than
reversing course.

## 30. Vector storage — verdict

**Keep LanceDB.** It is already the vector store, already proven at real
scale in production use (the existing neuron table), already has a working
Windows-compatible packaging story (it's already shipped and running
today), and already has the exact scoped-query capability
(`searchNeuronsByIds`, `.where("id IN (...)")`) NB-2+'s chunk-level
retrieval needs — just applied to a `chunks` table instead of (or in
addition to) `neurons`.

| Criterion | LanceDB (current) | SQLite vector extension (e.g. sqlite-vec) | Other minimal option |
|---|---|---|---|
| Windows support | proven — already running | plausible but unverified in this repo | UNKNOWN without installing something, which NB-1 must not do |
| Packaging | proven — already a dependency | would be a new dependency | new dependency |
| Local-first | yes | yes | depends |
| Maintenance | already the team's operational reality | new surface to learn | new surface to learn |
| License | already accepted (existing dependency) | UNKNOWN until checked (§49) | UNKNOWN |
| Performance | proven at existing neuron-store scale | UNKNOWN without benchmarking | UNKNOWN |
| Backup | already part of existing backup story | would need new backup handling | would need new backup handling |

**Verdict: LanceDB, unchanged as the vector backend.** A `chunks` table
(new) alongside `neurons` (existing, unchanged) is simpler and lower-risk
than migrating to or adding a second vector engine. **0 new vector
infrastructure proposed.**

## 31. Observateur integration boundary

Observateur (`monitor-service.js`) is a read-only local signal producer —
connections, processes, anomalies. Future Notebook integration:

```
Observateur result → user explicit action ("Add to Notebook") → Source
```

**No automatic bulk ingestion of Observateur output into any Notebook.**
Every promoted item keeps its provenance (which Observateur signal, when,
what rule fired) as a `ProvenanceRecord`. This mirrors exactly how
Adaptive Memory's "learn from neurons" hook already deliberately excludes
bulk/connector-sourced neurons from automatic memory extraction (§0.1) —
the same "bulk automatic ingestion floods and de-values the store" concern
applies identically here, so NB-1 applies the same existing answer rather
than inventing a new one.

## 32. MSN / publisher news — future

Future publisher/MSN articles may be imported into Notebook, but
`canonicalUri` and source metadata must remain visible at all times — this
is `Source.canonicalUri` (§3.1) doing exactly its job. **Never store an
opaque, unattributed copy of an internet article** — every imported article
must be traceable to where it came from, permanently, even if the original
URL later goes offline.

## 33. OpenPlanter / investigation — future compatibility only

Future compatibility with entities, evidence, relationships, and
investigation notes should be possible via the same `Source`/`Document`/
`ProvenanceRecord` model (an "entity" or "evidence" item is just a Source
with `type` reflecting its investigative origin) — **no OpenPlanter
integration is designed or built in NB-1.** This section exists only to
confirm the data model doesn't structurally block it later.

## 34. Agency — read-only future access, gated actions

A future Agency-style agent may query Notebook **read-only**. It must
never be able to autonomously: send email, publish, mutate a CRM, purchase,
or post to social media, as a consequence of a Notebook read.

**Follow MAÎTRE's existing precedent exactly**: MAÎTRE's own ingestion/
correlation pass is explicitly "read/analyze/persist only — no system
action"; any actual action requires the separate propose → approve →
execute pipeline with a human approval step. A future Agency reading
Notebook must have the identical shape: **Notebook read access and action
authority are two structurally separate permission surfaces**, and nothing
in Notebook's own design grants the second one. This is not new
infrastructure to build now — it's a constraint on how any future Agency
integration must be wired, stated so NB-2+ doesn't accidentally couple
"can read Notebook" with "can act."

## 35. Device Fabric boundary

Device Fabric V2 is FROZEN. **Notebook inherits none of its permissions.**
Notebook → Device Fabric automatic route: **0**. Notebook content must
never be able to provoke a remote-control action — this is the same
structural-non-connection guarantee as §11 (tool injection), specifically
called out for Device Fabric because of its remote-control capability.
**No Device Fabric import is proposed anywhere in the Notebook design.**

## 36. RASSILON boundary

Future possibility, **not built in NB-1**: use RASSILON to compute an
embedding batch, only if explicitly requested by the user and only if the
`EMBEDDING_BATCH` job type (already exists, confirmed in `rassilon-embedding.js`
+ `rassilon-job-schema.js`, allowlisted to `nomic-embed-text` — §0.1) is
authorized. This is not a new capability to build — NB-2+'s bulk-reembedding
need (e.g. re-embedding an entire Notebook after a model-version bump, per
§19) already has a place to plug into. **0 modification to RASSILON is
proposed or needed** — Notebook would be a new *caller* of an existing job
type, exactly like Device Fabric's own `RASSILON_EMBEDDING` routing already
is a caller of it, never a new RASSILON capability.

## 37. Gemini — optional provider only

Gemini must be an **optional** provider, never a core dependency.

Possible future abstract interface (design only, **not implemented**):

```
interface NotebookCloudProvider {
  generate(prompt, context): Promise<string>;
  embed(text): Promise<number[]>;
  summarize(text): Promise<string>;
}
```

Follow the exact pattern already proven by `notebook-provider.js` (§0.1):
`NOTEBOOK_PROVIDERS = { local: available, gemini: unavailable_until_configured }`,
zero network code path until a real integration mission explicitly builds
one, key storage via the existing DPAPI `secret-store.js`, complete
decoupling from the local Q&A route file. **0 Gemini connection created by
this mission**, per the mission's explicit instruction.

## 38. Google Drive — future connector only

Future connector, **not implemented**. Design constraint only: a Drive
connector's job would be to hand a document to the existing ingestion
pipeline's entry point (§12's per-format parsers) exactly like a local file
upload would — a connector is a *source of bytes*, never a bypass of
security filtering, secret scanning, or the STRICT LOCAL default. Reuse the
existing `google-drive-connector.js`'s established OAuth/DPAPI-key pattern
(already used for the existing connector-sourced neuron import) rather than
inventing a new cloud-auth mechanism.

## 39. Notebook UI — future UX

Concept only:

- Notebook list
- Source list (per notebook)
- Source details (metadata, trust level, privacy level, version history)
- Search
- Ask (existing Q&A, extended with trust-level-aware citation display)
- Citations (source, passage, trust level, `FACT_FROM_SOURCE` vs
  `PAST_AI_ASSERTION` distinction per §5, always visible)
- Conversation (existing chat-shaped Q&A history)
- Artifacts (flashcards/timeline/comparison — currently honestly
  unimplemented per Phase 5; NB-6+ scope)
- Settings (privacy mode, retention defaults, embedding status)

**Always show which source supports what** — extends the existing
Phase 5 `NotebookModal.tsx` three-column layout's already-correct
"citations trace to a real source" principle to the richer source types
NB-2+ introduces.

## 40. Privacy UI

STRICT LOCAL / HYBRID / CLOUD must always be visibly displayed. Any cloud
operation must be visible **before** it executes — this exact pattern
already exists for NotebookLM export (`confirm: true` required, 409
otherwise, explicit "no Google call happened" copy) and must be the
template for every future cloud-touching Notebook action, not a
one-off built specifically for NotebookLM.

## 41. Import UX

Future flow:

```
Add Source → choose file → security scan (§12, §27) → preview metadata
  → choose Notebook → choose retention (§26) → confirm → index
```

**No silent import of entire folders by default** — every import is a
deliberate, visible, per-document (or explicitly-batched-and-confirmed)
action. This directly constrains §42.

## 42. Folder watching — audit only

If ever considered later:

- **OFF by default**
- explicit directory only (never a recursive whole-drive scan)
- bounded (max file count / size per watch)
- visible (UI must show what's being watched and what it has indexed)
- revocable (one click to stop watching, with a clear statement of whether
  already-indexed content is also removed or just stops updating)

**Not designed further than this constraint list — no folder-watching
mechanism is proposed for implementation in NB-1 or any near-term phase.**

## 43. Backup / export format

Portable export, design only:

- **JSON manifest** — Notebook metadata, source list with provenance,
  citation history; the natural machine-readable format
- **Markdown** — human-readable export (extends the existing
  NotebookLM-prep Markdown export mechanism, §0.1, generalized beyond
  just NotebookLM-prep to a general-purpose portable export)
- **Source references** — for `type=NEURON_REF` sources, the export
  references the neuron id rather than duplicating content (consistent
  with never-duplicate-content principle); for raw `DOCUMENT` sources, the
  export can optionally bundle the original file
- **SQLite backup** — the existing whole-database backup mechanism already
  covers Notebook's own tables since they live in the same DB (§29) — no
  separate backup tooling is needed structurally, though a Notebook-scoped
  partial export (not the whole app DB) is still useful for sharing a
  single Notebook

**No proprietary or cloud-dependent format** — every export option above
is fully self-contained and openable without Docteur.

## 44. Deletion / forget

The user must be able to: remove a Source, remove a Conversation, delete a
Notebook entirely, purge embeddings. Consequences per action must be
documented at build time (§25's cascade rules, extended per-entity) —
deferred to NB-2's actual implementation, but the principle (every deletion
path's exact cascade and audit-trail retention must be written down before
shipping, not discovered after) is set here.

## 45. Scale targets

| Scenario | Disk (rough) | RAM (rough) | Embedding time (rough, CPU) | Search latency target |
|---|---|---|---|---|
| 100 documents | tens of MB | negligible | seconds | <1s (already proven — Phase 5 tested 100 sources at ~1.7s) |
| 1,000 documents | ~100s of MB | low tens of MB for working set | minutes, batchable | <2s |
| 10,000 documents | low GB | tens-hundreds of MB depending on chunk count | tens of minutes, should be backgroundable/RASSILON-offloadable (§36) | <3s, hybrid ranking may need index tuning |
| 100k chunks | GB-scale (LanceDB) | depends on LanceDB's own memory-mapped access pattern | N/A (already embedded) | search latency is the real constraint — FTS5 + LanceDB `.where()` pushdown should hold, but needs real benchmarking before NB-3 ships |
| 1M chunks | multi-GB | same | N/A | genuinely needs profiling before promising a number — flag as **UNKNOWN, needs NB-3 benchmarking**, not a guess |

**No premature optimization for billions of documents** — these targets
cover realistic personal/small-team Notebook usage, not a search-engine
scale system. LanceDB and SQLite FTS5 are both proven at far larger scales
than 1M rows in general, so the recommendation is to build for the 10k-100k
range with correctness and citation integrity as the priority, and
benchmark before promising numbers beyond that.

## 46. Test strategy (future)

Unit, parser (per-format), database (schema/migration), retrieval
(scoping/ranking correctness), citation (never-fabricated, always-resolves),
security (§47), prompt injection (§10), privacy (STRICT LOCAL boundary,
§48), cloud boundary (opt-in only, visible), migration (additive-only,
mirrors Device Fabric V2's own migration-test template), browser
(Playwright, mirrors the existing Phase 5 visual-verification pattern).

## 47. Security test matrix (future)

malicious PDF · HTML script · prompt injection text · zip bomb · path
traversal · huge file · duplicate file · malformed JSON · secret-containing
text · unsupported format · deleted source (retrieval-after-delete must
return nothing, never a stale cached result) · conflicting sources ·
fake/hallucinated citation (must be structurally impossible, not just
tested-against) · retrieval after deletion.

## 48. STRICT LOCAL proof (future)

To prove later: network requests = 0, cloud calls = 0, telemetry = 0, for
STRICT LOCAL mode specifically. **Design for a negative network test**:
spawn the Notebook ingestion/retrieval/Q&A path against a network-request
interceptor that throws on any non-loopback connection attempt (the exact
pattern already used in the Phase 5B NotebookLM test — "mock `fetch` that
throws if called" — generalized from one file to the whole Notebook
request path). This is not new test infrastructure to invent; it's the
existing pattern applied more broadly.

## 49. License audit (future, per candidate library)

For any future DOCX library or other new dependency: license, commercial
compatibility, copyleft implications, redistribution terms, Windows
packaging — **UNKNOWN for any library not yet verified**, and NB-1
verifies none because NB-1 installs nothing. This check must happen at the
point a real dependency is proposed (NB-2+), not deferred further.

## 50. Dependency budget

Prefer a small number of well-maintained dependencies. Avoid a heavyweight
RAG framework (LangChain-style all-in-one frameworks) when the actual needs
(chunking, FTS5, vector search via LanceDB, a hybrid-ranking merge
function, per-format parsers) can be satisfied with the small set of
already-present or narrowly-scoped new dependencies this document
identifies (§12, §18). **This audit adds 0 dependencies.** Any future
phase should be able to name, for each new dependency it proposes, exactly
what existing capability is insufficient — not add a framework "to be
safe."

## 51. Threat model

| Threat | Mitigation direction |
|---|---|
| Malicious document (embedded exploit, macro, zip bomb) | §12 per-format limits, non-executing parsers, no code execution during parsing |
| Prompt injection | §10 structural isolation, never rely on the model "deciding" to ignore |
| Malicious webpage | §13 no script execution, no remote resource fetch by default |
| Secret exfiltration | §27 pre-index scanning + §2's existing `privacy-guard.js` hard backstop |
| Cloud misconfiguration | §2's two-layer boundary (`strict-local.js` toggle + `privacy-guard.js` backstop) — a misconfigured toggle still can't leak sentinel-marked content |
| Parser vulnerability | §12, §50 — prefer simple, well-audited, non-code-executing parsers; keep the dependency surface small |
| Database corruption | inherits Docteur's existing SQLite/LanceDB operational practices; no new risk introduced by additive tables |
| Citation spoofing | §22's citation pack + existing `extractCitations()` in-range-only guarantee — structurally impossible, not just discouraged |
| Cross-notebook leakage | §52 — explicit-only cross-notebook search, scoped-by-id retrieval already proven (`searchNeuronsByIds` pattern) |
| Stale embeddings | §19 embedding versioning — flag or exclude rather than silently compare incompatible vectors |
| Dependency compromise | §50's small-dependency-surface preference reduces (never eliminates) this exposure; standard supply-chain hygiene (lockfiles, already in place via `package-lock.json`) applies unchanged |

## 52. Cross-notebook isolation

Notebook A must never automatically retrieve sources from Notebook B.
Cross-notebook search is **explicit only** — a deliberate user action that
names which notebooks to search across, never a default. This extends the
existing scoped-retrieval guarantee (`searchNeuronsByIds`, already proven
to never leak outside a single notebook's source-id list, per Phase 5's
own test: "a neuron outside the notebook, even highly semantically
relevant, never appears") to the notebook-to-notebook boundary, not just
the notebook-to-whole-neuron-store boundary it already covers.

## 53. Personal memory (future, not built)

A future "Docteur Memory" layered above individual notebooks is plausible
but **not designed in detail here, and not built**. Constraint to record
now: global memory must draw only from **explicitly promoted or validated**
elements, never automatically from every conversation or every Notebook
source. This is consistent with Adaptive Memory's existing philosophy
(rule-based extraction with a confirm step for anything beyond simple
deterministic patterns, never "remember everything").

## 54. AI history as memory — architecture decision

```
AI history → dedicated Notebook (via §6-7's distillation pipeline)
  → (later, separate, explicit step) →
    selected facts → Docteur Memory
```

**Never pour years of chat history directly into the system prompt.** This
two-step design (import → dedicated Notebook first, promotion to any
broader memory only as a distinct, later, explicit step) is what keeps
§53's "explicitly promoted only" constraint enforceable — if AI history
went straight into a global memory, there would be no meaningful promotion
gate at all.

## 55. Performance budgets (future)

Import latency, embedding throughput, search latency, max document size,
max concurrent imports — all to be **measured, not guessed**, once NB-2
has a real implementation to benchmark. §45 gives rough scale-target
ranges; exact budgets are an NB-2/NB-3 deliverable, not an NB-1 one.

## 56. Error model

```
UNSUPPORTED_FORMAT | FILE_TOO_LARGE | PARSER_FAILED | SECURITY_BLOCKED |
SECRET_DETECTED | EMBEDDING_UNAVAILABLE | INDEX_FAILED | SOURCE_DELETED |
CLOUD_DISABLED | PROVIDER_UNAVAILABLE
```

Each a distinct, user-facing, safe (no stack trace, no raw parser error
text) code — mirrors Device Fabric V2's own closed safe-error-vocabulary
pattern (`OMEGA_V2_*` codes) rather than surfacing raw exceptions.

## 57. Observability

Loggable: import status, parser error (code only, per §56), index status,
model used, timing. **Never logged by default**: document body, detected
secrets, private conversation text — mirrors the existing `cv-import.js`
("extracted text is NEVER logged") and `privacy-guard.js` incident-logging
(ids/codes only, never content) precedents exactly.

## 58. Required architecture decisions — verdicts

| # | Decision | Verdict |
|---|---|---|
| A | Single DB vs separate Notebook DB | **Single DB** — extend existing `sqlite.js` (§29) |
| B | FTS only vs vector only vs hybrid | **Hybrid** — SQLite FTS5 + LanceDB vector + merged ranking (§17) |
| C | Vector backend | **LanceDB**, unchanged (§30) |
| D | Embedding abstraction | Keep Ollama/`nomic-embed-text` as the sole provider; formalize the existing implicit interface (`embedText`) as a named abstraction only if/when a second provider is ever genuinely needed — not preemptively (§18) |
| E | Citation data model | Extend the existing structured `[N]`→chunk model with `trustLevel` and fact-category tagging (§5, §22) |
| F | Source versioning | New `DocumentVersion` entity; never silent overwrite (§16) |
| G | Secret scanning | Reuse `cyber-redact.js`'s pattern; BLOCK/REDACT/USER_CONFIRM; feed hits into the existing `privacy-guard.js` sentinel mechanism (§27) |
| H | Cloud boundary | Reuse `strict-local.js` (toggle) + `privacy-guard.js` (hard backstop) unchanged (§2) |
| I | AI history ingestion architecture | Dedicated Notebook per import, distinct content-type-tagged messages, never flattened, promotion to broader memory is a separate later step (§6-7, §54) |
| J | Observateur integration boundary | Explicit "Add to Notebook" only, provenance kept, no bulk auto-ingestion (§31) |
| K | RASSILON future compute boundary | Reuse existing `EMBEDDING_BATCH` job type as a new caller, explicit-request only, no RASSILON modification (§36) |
| L | Global Memory boundary | Not built now; explicitly-promoted-only constraint recorded for when it is (§53-54) |

## 59. Phase plan (proposed, not started)

```
NB-2 — STRICT LOCAL MVP
  Raw document ingestion (PDF/TXT/MD first; HTML via existing jsdom
  sanitize pattern), Document/DocumentVersion/Chunk tables, FTS5 added
  alongside existing vector search, basic hybrid ranking, secret scanning
  (BLOCK/REDACT/USER_CONFIRM) before indexing, trust levels on Source.

NB-3 — ROBUST LOCAL RAG + CITATIONS
  Chunk-level embeddings (replacing today's neuron-level-score-as-chunk-
  score approximation), embedding versioning, citation pack formalized,
  answer contract (uncertainties/sourceConflicts), contradiction display,
  reranking evaluation, real scale benchmarking (§45/§55 measured, not
  estimated), security test matrix (§47) built out.

NB-4 — AI HISTORY IMPORT / DISTILLATION
  Per-format parsers (ChatGPT/Gemini/Claude exports), content-type
  separation, secret scanning pass, optional human-reviewed semantic
  extraction, dedicated per-import Notebooks, PAST_AI_ASSERTION citation
  handling end-to-end in the UI.

NB-5 — OPTIONAL GEMINI PROVIDER
  Real implementation of the abstract interface sketched in §37, following
  the exact `notebook-provider.js` decoupling pattern, opt-in only, never
  auto-enabled, visible-before-execution cloud UI (§40).

NB-6 — CONNECTORS / ARTIFACTS
  Google Drive connector (§38), Artifact entity + the previously-honestly-
  unimplemented tools (flashcards/timeline/comparison/glossary), folder
  watching only if still wanted (§42's constraints apply in full).

NB-7 — FINAL SECURITY CERTIFICATION + FREEZE
  Full security test matrix execution, STRICT LOCAL negative-network proof
  (§48), threat model (§51) re-verified against the shipped implementation,
  final certification report, freeze declaration — mirrors Device Fabric
  V2's own Phase 6 certification structure.
```

**None of these phases are started by this mission.**

## 60. Output

This report is the only file this mission created:
`reports/DOCTEUR_NOTEBOOK_NB1_ARCHITECTURE_SECURITY_PRIVACY_2026-09.md`.

---

# DOCTEUR NOTEBOOK NB-1 FINAL CHECKPOINT

```
Architecture audit:                                PASS
Strict Local default:                              PASS
Cloud optional only:                                PASS

Notebook data model:                                PASS
Source provenance:                                  PASS
Document versioning:                                PASS
Chunk provenance:                                   PASS
Citation architecture:                              PASS

FTS architecture:                                   PASS
Vector architecture:                                PASS
Hybrid retrieval decision:                          SQLite FTS5 + LanceDB vector + merged (BM25+score) ranking, graceful FTS5-only fallback if embeddings unavailable

Embedding abstraction:                              PASS
Embedding versioning:                               PASS

Prompt injection isolation:                         PASS (design — net-new, no prior module existed; positional isolation + non-spoofable delimiters + pattern pre-filter)
Tool injection isolation:                           PASS (structural non-connection, no executor import anywhere in the design)

Parser threat model:                                PASS
Secret scanning design:                             PASS (reuses existing cyber-redact.js pattern + privacy-guard.js hard backstop)
Cross-notebook isolation:                            PASS
Deletion/purge semantics:                            PASS
Retention policies:                                  PASS

AI history ingestion design:                        PASS
Past AI output treated as verified fact:             0
Automatic global memory ingestion:                   0
Observateur automatic bulk ingestion:                0
Device Fabric permission inheritance:                0
RASSILON permission inheritance:                     0
Automatic remote control:                            0
Automatic publication:                               0
Cloud upload in Strict Local:                        0
Telemetry in Strict Local:                           0

Google Drive implemented:                            0
Gemini implemented:                                  0
Dependencies installed:                              0
Functional code modified:                            0
Frozen modules modified:                             0

Report:                                              reports/DOCTEUR_NOTEBOOK_NB1_ARCHITECTURE_SECURITY_PRIVACY_2026-09.md

Recommended NB-2 architecture:
  Extend the existing (already-live, already-tested) Phase 5 Notebook —
  single Docteur SQLite DB (new additive tables: documents, document_versions,
  chunks, provenance_records), LanceDB unchanged as vector backend (new
  chunks table alongside existing neurons table), SQLite FTS5 added as a
  new capability, Ollama + nomic-embed-text unchanged as the sole embedding
  provider, secret scanning via the existing cyber-redact.js pattern feeding
  the existing privacy-guard.js sentinel backstop, per-format parsers reusing
  existing pdf-parse/jsdom/@mozilla/readability dependencies plus one new
  DOCX-safe parser to be license-audited at proposal time. 0 new vector
  infrastructure, 0 new cloud provider, 0 new cryptographic primitive.

Blocking issues:
  None for proceeding to NB-2 design/implementation. One design gap was
  identified and addressed in this document rather than left open:
  no prior prompt-injection defense existed anywhere in the codebase (§10) —
  a structural (positional isolation + non-spoofable delimiters), not
  purely pattern-based, design is specified here and must be implemented
  as part of NB-2's ingestion pipeline, not deferred.

Verdict:                                             READY_FOR_NB2
```

STOP. NB-2 not started. No dependency installed. Device Fabric V2, OMEGA,
RASSILON not modified.
