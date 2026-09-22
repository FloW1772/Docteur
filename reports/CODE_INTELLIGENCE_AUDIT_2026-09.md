# DOCTEUR — CODE INTELLIGENCE AUDIT

Research date: 2026-09-21
Scope: audit-only, per mission "PHASE 4 — CODE INTELLIGENCE AUDIT". No code produced, no packages installed, no provider integrated.

---

## 1. Current Docteur capabilities (existing code, audited before any external research)

Docteur already has substantially more "code intelligence" infrastructure than a naive gap analysis would assume. Five things exist today:

### 1a. MetaGPT pipeline (local, Ollama-only, approval-gated)
`cortex-server/src/lib/metagpt-orchestrator.js` + `metagpt_runner_*.py`. Full state machine: `PLANNING → PRD_READY → DESIGN_READY → TASKS_READY → GENERATING → CODE_READY → PREPARING_DIFF → AWAITING_APPROVAL → APPLYING → APPLIED`. Produces plan (PRD/Design/Tasks), text-only codegen (≤10 files), a diff + SHA-256-bound approval package, and an apply step limited to **CREATE-on-absent only**, always into `src/_metagpt_generated_samples/{jobId}/` — never the real repo tree directly. Approval requires exact `diff_sha256` + file-list match; the Python apply runner independently re-validates hashes rather than trusting the Node-side approval claim. No Terminal/Bash/Browser/Git/cloud in this path (`src/content/capabilities.ts` states this explicitly).

### 1b. `external-agents.js` — a working Claude-CLI/Codex-CLI coding-agent abstraction
`cortex-server/src/lib/external-agents.js` (+ `external-agent-process.js`, frontend `src/lib/cortex/external-agents.ts`, `src/components/panels/ExternalAgentsPanel.tsx`). This is the single most relevant piece of prior art for this audit:
- Launches the real `claude`/`codex` CLIs (resolved via `resolveCli()`, never via shell) to read and edit code.
- Files are copied into an isolated `mkdtemp` staging workspace under OS temp — **the agent never touches the real repository directly**.
- Full lifecycle: `preview()` → `approve()` (5-minute expiry) → `execute()` (diffs computed from staged before/after) → `review()` (second explicit approval, with conflict detection against the live file state, before anything is written back) → `undo()` (session-scoped reversal).
- Modes are `read`/`edit` only — Shell, build/test, and "full" execution are explicitly unavailable (`settings()` message: *"Shell, build/test et FULL indisponibles : commandes non exécutées."*).
- `checkCloud()` enforces Strict Local on every entry point before any Claude/Codex CLI call.

This already **is**, structurally, a minimal Code Intelligence gateway: read → analyze → propose diff → human review → apply, workspace-scoped, no arbitrary shell.

### 1c. Provider abstraction for LLM text generation
`cortex-server/src/lib/providers/claude-oauth.js` and `codex.js`, both extending `BaseProvider`, both wrapped in `guardCloudCall()` (private-content sentinel check) and `planSafeSpawn()` (avoids `shell:true` for prompt execution). No GitHub Copilot integration exists anywhere (`grep -i copilot` → 0 matches).

### 1d. Repository/code search — does NOT exist
`cortex-server/src/routes/search.js` searches Docteur's own knowledge-base "neurons" (notes/memory) via hybrid substring + LanceDB embedding search. **This is not code search.** There is no file-tree indexer, no grep/ripgrep wrapper, no "search this codebase" endpoint anywhere in the server. `metagpt_safe_project_context.py` is a narrow, mission-scoped context builder, not general code search.

### 1e. Git operations — read-only tooling does NOT exist
No programmatic git calls exist in Docteur's own JS/TS code at all (only a defensive comment in `external-agents.js` disclaiming git use). `metagpt_git_guard.py` is a regression test that asserts MetaGPT's vendored library never invokes real git — not a capability. **No git status/diff/log/show wrapper exists**, not even read-only.

### What Docteur already knows how to do
Local, approval-gated plan→diff→apply for new-file generation (MetaGPT); staged-workspace, approval-gated read/edit via real Claude/Codex CLIs with diff review and undo (external-agents); provider-abstracted cloud LLM text generation with Strict Local and privacy-guard enforcement.

### What's genuinely missing
Repository-wide source-code search/indexing (symbol-aware or otherwise) and any git read tooling (status/diff/log/show). Nothing today lets Docteur or an agent answer "where is X defined" or "what changed in this file's history" without a human manually running those commands outside the app.

---

## 2. Real gaps — classified

| Capability | Classification | Notes |
|---|---|---|
| Semantic repository indexing (source code) | **REAL GAP** | Only note/memory embeddings exist (§1d) |
| Symbol/reference search | **REAL GAP** | No AST/LSP/tree-sitter anywhere in the server |
| Dependency graph | **REAL GAP** | Not attempted anywhere |
| Codebase-wide context | PARTIAL | `metagpt_safe_project_context.py` does this narrowly, mission-scoped only |
| Code graph | **REAL GAP** | None |
| Incremental indexing | **REAL GAP** | N/A, nothing to increment |
| Large repository support | N/A (untested) | No indexer exists to evaluate against `external/MetaGPT`/`external/OpenMontage` scale |
| Structured code navigation | **REAL GAP** | None |
| Multi-file refactoring plans | PARTIAL | MetaGPT plans multi-file but codegen is text-only, ≤10 files, new-file-only apply |
| Safe patch generation | ALREADY COVERED | Both MetaGPT and external-agents already do hash-bound, approval-gated diff generation |
| Test-aware modifications | **REAL GAP** | No test-execution boundary exists in either existing pipeline |
| Local-model coding workflows | ALREADY COVERED | MetaGPT is Ollama-only by design; external-agents supports Claude/Codex CLI (not strictly "local" but already gated) |
| Read-only git (status/diff/log/show) | **REAL GAP** | Confirmed zero existing tooling, explicitly called out in mission §11 |

**Net finding**: the two REAL GAPS with actual product value are (1) source-code search/symbol navigation, and (2) read-only git tooling. Diff generation, apply-with-approval, and staged-workspace isolation are **already covered** by existing Docteur code and must not be duplicated.

---

## 3. Research methodology

Web search + direct fetch of official repositories, documentation, and license files, dated 2026-09-21. Prioritized canonical GitHub orgs and official docs sites over blogs/SEO content/affiliate comparisons. Where a fact could not be independently verified (e.g. exact current telemetry default for a specific tool), it is marked `UNKNOWN` below rather than assumed.

---

## 4. Candidates evaluated

### Category key
A = IDE assistant · B = CLI coding agent · C = autonomous coding agent · D = repository intelligence/indexer · E = agent framework · F = hybrid

### Aider
- **Category**: B (CLI coding agent)
- **Canonical repository**: github.com/Aider-AI/aider
- **Official docs**: aider.chat
- **Latest stable release / date**: actively released through 2026; commit activity as recent as May 2026 confirmed
- **License**: Apache-2.0
- **Commercial use**: permitted (Apache-2.0)
- **Windows support**: runs via pip install; no confirmed Docker requirement; one open issue (#4433, filed 2025-08-09, still open/unresolved) shows PowerShell/tree-sitter repo-map support is incomplete — a language-support gap, not a platform blocker
- **Linux-only dependency?**: No
- **Docker required?**: No (optional, a `/docker` dir exists for containerized use)
- **Runtime**: Python
- **Local model support**: YES — explicitly supports Ollama and OpenAI-compatible local endpoints
- **Cloud model support**: YES — Claude, DeepSeek, OpenAI, Gemini
- **OpenAI-compatible support**: YES
- **Anthropic-compatible support**: YES
- **Ollama support**: YES
- **LM Studio support**: UNKNOWN (not directly confirmed, likely via OpenAI-compatible endpoint)
- **Repository indexing**: YES — tree-sitter-based AST repo map, token-efficient symbol index passed to the LLM as context
- **Semantic search**: UNKNOWN (repo map is symbol/AST-based, not embedding-based; no confirmation of vector search)
- **Symbol awareness**: YES (via tree-sitter)
- **AST/LSP usage**: tree-sitter AST; no LSP
- **Code graph**: PARTIAL (repo map is a symbol index, not a full dependency graph)
- **Diff generation**: YES
- **Direct editing**: YES, directly to working tree files
- **Test execution**: UNKNOWN — not confirmed whether it can invoke test commands itself
- **Terminal access**: BOUNDED — primary interaction is the chat/edit loop plus git commit; not a general arbitrary-shell agent by default
- **Git access**: **Auto-commits every change by default** ("Aider automatically commits changes with sensible commit messages"). `--no-auto-commits` flag exists to disable this.
- **Browser access**: UNKNOWN
- **MCP/tools/plugins**: UNKNOWN
- **Approval model**: Weak by default — auto-commit means changes land in git history without a separate "apply" gate unless `--no-auto-commits` is explicitly set
- **Sandbox model**: NO SANDBOX — runs directly against the working tree
- **Telemetry**: Opt-in only, anonymized UUID4, never collects code/chat/keys/personal info; source of collection points is itself open source and auditable
- **Network requirements**: only to the configured LLM endpoint (local or cloud)
- **Secret handling**: UNKNOWN — no explicit confirmation of `.env`/secret-file exclusion from context
- **Maintenance activity**: Active (41.6k stars, commits into 2026)
- **Integration complexity**: LOW-MEDIUM (Python CLI, subprocess-invokable)
- **Rejection-relevant flags**: auto-commit-by-default is a real friction point against Docteur's "no destructive git authority" preference (§11/§34) unless configured off at every invocation.

### Cline
- **Category**: F (hybrid — IDE extension + CLI + SDK)
- **Canonical repository**: github.com/cline/cline
- **Latest stable release**: v3.81 (2026), 61.2k–67k stars depending on source
- **License**: Apache-2.0
- **Commercial use**: permitted
- **Windows support**: YES — native Windows app exists in addition to VS Code/JetBrains/CLI
- **Linux-only dependency?**: No
- **Docker required?**: No
- **Runtime**: Node/TypeScript (VS Code extension architecture) + native app
- **Local model support**: YES — Ollama, LM Studio, any OpenAI-compatible API
- **Cloud model support**: YES — Anthropic, OpenAI, Gemini, others
- **OpenAI-compatible support**: YES
- **Anthropic-compatible support**: YES
- **Ollama support**: YES
- **LM Studio support**: YES
- **Repository indexing**: PARTIAL — reads project structure and file relationships; no confirmed dedicated symbol/AST index
- **Semantic search**: UNKNOWN
- **Symbol awareness**: UNKNOWN (not explicitly confirmed beyond "understands file relationships")
- **AST/LSP usage**: UNKNOWN
- **Code graph**: UNKNOWN
- **Diff generation**: YES
- **Direct editing**: YES
- **Test execution**: YES, via terminal command execution
- **Terminal access**: **ARBITRARY TERMINAL** — "executes commands directly in your terminal and watches the output in real time"; can install packages and run arbitrary commands. Auto-approve can be toggled to let it run fully autonomously.
- **Git access**: not specially restricted — flows through general terminal command execution, so effectively unrestricted including destructive git operations, unless the user declines individual command approvals
- **Browser access**: YES (documented capability)
- **MCP/tools/plugins**: YES — dedicated marketplace, can both use and create MCP tools, no artificial limit
- **Approval model**: per-action approval by default ("every file edit and terminal command requires your approval"), but **can be toggled to full autonomy** (auto-approve)
- **Sandbox model**: NO SANDBOX — runs with the permissions of the host process/user account
- **Telemetry**: **Opt-out** (enabled by default), but explicitly excludes code/file contents, file paths, command arguments, conversation content, and credentials — only feature-usage/error/performance metrics
- **Network requirements**: to configured model endpoint; MCP marketplace calls out to the internet if used
- **Secret handling**: UNKNOWN — no confirmed `.env`/secret exclusion mechanism found
- **Maintenance activity**: Very active, large community, multi-platform investment in 2026
- **Integration complexity**: MEDIUM — SDK exists for programmatic use, reducing IDE-lock-in concern, but the arbitrary-terminal default is a significant integration-complexity driver (would need Docteur to wrap/restrict it, not just call it)
- **Rejection-relevant flags**: ARBITRARY TERMINAL by default is a direct conflict with mission §9/§29 ("terminal arbitraire automatiquement" is explicitly to be avoided); auto-approve toggle makes this worse, not better, from a security-boundary standpoint.

### OpenHands (formerly OpenDevin)
- **Category**: C (autonomous coding agent)
- **Canonical repository**: github.com/OpenHands/OpenHands (formerly All-Hands-AI)
- **License**: MIT
- **Windows support**: **NO native support** — requires WSL2 + Docker Desktop on Windows
- **Docker required?**: **YES, mandatory** — each session runs inside an isolated Docker sandbox with terminal, editor, browser, filesystem
- **Runtime**: Python backend + Docker
- **Local model support**: YES (via configurable endpoint)
- **Terminal access**: ARBITRARY TERMINAL, but sandboxed inside its own Docker container (isolation is real, but the container itself gets full shell)
- **Maintenance activity**: Active, ~85k stars, 72% SWE-bench Verified score cited for 2026
- **Rejection-relevant flags**: **Windows unsupported natively** (mission §8/§34 explicit rejection condition: "Windows unsupported"), **Docker mandatory** (mission §34 explicit rejection condition). Both are hard rejection triggers per this mission's own criteria. **Not evaluated further** — excluded on Windows-first grounds alone.

### Continue.dev
- **Category**: A (IDE assistant)
- **Status**: **Effectively dead as an independent open-source project.** Acquired by Cursor (June 2026); the open-source `continuedev/continue` repository is now **read-only/archived**, with v2.0.0 as its final release.
- **Rejection-relevant flags**: Mission §26/§34 explicit rejection condition ("dead/unmaintained"). **Excluded — archived, no further development possible.**

### Roo Code
- **Category**: A/F (VS Code extension, Cline-derived)
- **Status**: **Shut down and archived, 2026-05-15.**
- **Rejection-relevant flags**: Same as Continue.dev — dead project. **Excluded.** (Community forks like Roo-Code-CLI exist but carry unknown maintenance depth and were not independently verified as viable — out of scope for a V1 recommendation.)

### SWE-agent (Princeton/Stanford)
- **Category**: C (autonomous coding agent, academic origin)
- **Canonical repository**: github.com/SWE-agent/SWE-agent (formerly princeton-nlp/SWE-agent)
- **License**: confirmed present (LICENSE file exists at canonical repo; exact license text not independently re-verified beyond confirming its existence)
- **Docker required?**: YES for the primary workflow (setup.sh builds a Docker image); a lighter "mini-swe-agent" variant exists (100 lines, no Docker requirement claimed, 65-74% SWE-bench Verified depending on source)
- **Windows support**: UNKNOWN for native use; Docker-based primary path implies the same Windows friction as OpenHands unless mini-swe-agent avoids it
- **Maintenance activity**: Active, academic-institution-backed, NeurIPS 2024 origin, continued 2026 activity (mini-swe-agent is a 2026-era addition)
- **Rejection-relevant flags**: designed around solving benchmark-style GitHub issues end-to-end autonomously (PLAN→shell→test→PR), not around Docteur's desired READ→PLAN→DIFF→APPROVE→APPLY boundary. Docker-first architecture repeats the OpenHands friction. **Not shortlisted** — closest fit (mini-swe-agent) is intriguing but underspecified on Windows support to recommend without a deeper follow-up audit.

### OpenAI Codex CLI
- **Category**: B (CLI coding agent)
- **Canonical repository**: github.com/openai/codex
- **License**: Apache-2.0 (notable for a vendor-authored agent)
- **Windows support**: YES — **native Windows sandbox implementation** (not WSL-dependent), configurable `unelevated`/`elevated` modes via `config.toml`; WSL2 path also available as an alternative
- **Docker required?**: No (Docker is only an optional fallback for constrained Linux containers lacking `bwrap`)
- **Runtime**: Rust (rewritten for speed/small footprint)
- **Local model support**: YES, via `model_providers` block in `config.toml` — built-in reserved provider IDs include `openai`, `ollama`, `lmstudio`. **Caveat**: Codex speaks the OpenAI *Responses* API, not just Chat Completions; a backend that only exposes Chat Completions (many local servers) needs a translating gateway (e.g. LiteLLM) in front of it.
- **Cloud model support**: YES (native, OpenAI's own API)
- **OpenAI-compatible support**: YES, with the Responses-API caveat above
- **Terminal access**: **BOUNDED TERMINAL** — OS-level sandbox (Seatbelt/macOS, Landlock+seccomp/Linux, native Windows sandbox), **network access disabled by default on every platform**, three approval modes (`on-request` default, `never` for CI, `untrusted` deprecated), plus a granular per-category prompt policy
- **Git access**: `.git` directories are explicitly protected as **read-only** inside the sandbox's writable root — the agent cannot rewrite git internals even if it tries
- **Filesystem access**: workspace-scoped by design (current directory + temp dirs), verifiable via `/status`
- **Approval model**: exactly the READ→PLAN→DIFF→APPROVE shape Docteur wants — proposes changes, developer reviews diffs in-terminal, only approved operations proceed
- **MCP/tools/plugins**: YES (documented MCP support in the broader Codex ecosystem)
- **Sandbox model**: YES — this is the strongest sandboxing story of any candidate reviewed, including native (non-WSL) Windows support
- **Telemetry**: UNKNOWN — not independently verified in this pass
- **Secret handling**: UNKNOWN — no explicit `.env`/secret-store exclusion confirmed, though the protected-paths model (`.git`, `.agents`, `.codex` read-only) suggests some precedent for path-based exclusion that could plausibly extend to secret files
- **Maintenance activity**: Active, vendor-backed (OpenAI), PowerShell support and Windows sandboxing improvements shipped in 2026
- **Integration complexity**: LOW — Docteur's `external-agent-process.js` **already resolves and launches the `codex` CLI today** (§1c/§1b of this audit) via `providers/codex.js`, meaning partial integration work already exists.
- **Key strength**: Best-in-class sandboxing + already partially wired into Docteur.
- **Key limitation**: Cloud-first by nature (OpenAI's own model); local-model routing works but requires the Responses-API gateway caveat to be solved for non-Ollama/non-LMStudio backends; would need Strict Local gating exactly like the existing `codex.js` provider already has.

### OpenCode (sst/opencode)
- **Category**: F (hybrid — terminal TUI + persistent local server)
- **Canonical repository**: github.com/sst/opencode
- **License**: MIT
- **Windows support**: UNKNOWN (not independently confirmed; Go-based CLI, plausible but not verified)
- **Docker required?**: No (optional)
- **Runtime**: Go (CLI) + TypeScript packages (monorepo, Turbo-based), persistent background server + TUI client architecture — sessions survive terminal disconnects
- **Local model support**: YES — claims 75+ LLMs, model-agnostic by design
- **Approval model**: two built-in agent profiles — "Build" (full access) vs. "Plan" (read-only, denies file edits by default, asks permission before bash commands); tool calls route through `ctx.ask()` for approval; **non-interactive mode auto-approves all permissions for the session** (a meaningful caveat if ever run headlessly)
- **Terminal access**: BOUNDED in "Plan" mode, effectively ARBITRARY in "Build" mode or non-interactive mode
- **MCP/tools/plugins**: YES, MCP tools follow the same permission model as native tools
- **Maintenance activity**: Very active, 95k-202k stars depending on source/date (rapid 2026 growth, cited by one source as "the dominant open-source coding agent in 2026")
- **Telemetry**: present (tool execution wrapped in telemetry spans) but opt-out mechanism not independently confirmed
- **Integration complexity**: MEDIUM — persistent server process is a new lifecycle-management surface for Docteur (similar class of concern to kiwix-serve from Phase 3: needs explicit localhost-only binding, lifecycle control)
- **Key limitation**: Windows support unverified; non-interactive auto-approve-all is a real risk if Docteur ever drove it headlessly without adding its own gate in front.

### Repository-intelligence-only alternative: Code-Index-MCP
Surfaced during research as a **structurally different category** of candidate — not a coding agent, but a pure MCP-based **repository indexer** (category D). Evaluated because it maps directly onto the two REAL GAPS identified in §2 (source search + symbol navigation) without touching any of the higher-risk terminal/git/apply surface.

- **Category**: D (repository intelligence/indexer) — explicitly NOT an editing agent
- **Canonical repository**: github.com/johnhuang316/code-index-mcp (one of several MCP code-index servers found; this one was checked in most detail — mission explicitly does not require an exhaustive list)
- **License**: MIT
- **Windows support**: YES — confirmed to run natively via `uvx` with documented Windows environment variable setup (`HOME`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`)
- **Docker required?**: No (Dockerfile exists as an optional deployment path only)
- **Runtime**: Python 3.10+
- **Local model support**: N/A — it is not a model-calling agent, it's a tool an existing agent (Claude Code, or Docteur's own future orchestrator) calls
- **Repository indexing**: YES — tree-sitter AST parsing, 10 languages with full AST support + 50+ file types via fallback strategy, persistent local cache
- **Symbol awareness**: YES
- **AST/LSP usage**: tree-sitter AST; no LSP
- **Diff generation**: **NO** — strictly read-only, no file modification capability of any kind
- **Terminal access**: **NO TERMINAL**
- **Git access**: NONE
- **Network requirements**: **NONE** — fully local, no network access required
- **Secret handling**: N/A — cannot read files outside its indexing scope by design; strictly search/analysis, nothing resembling an "include this file in context" prompt-injection surface for secrets beyond normal filesystem read permissions
- **Invocation**: MCP server over stdio — the exact integration surface Claude Code (already in use as this dev tool) and other MCP-capable clients consume natively
- **Maintenance activity**: Active (257 commits, 1k stars, 120 forks, ongoing issue/PR activity)
- **Integration complexity**: **LOW** — stdio MCP server, no new process-lifecycle/port/network-exposure concern (unlike kiwix-serve or OpenCode's persistent server), no new approval primitive needed because it cannot write anything
- **Key strength**: Directly fills the one REAL GAP (source-code search/symbol navigation) with essentially none of the risk surface (terminal, git, apply, secrets, network) that every full coding-agent candidate carries.
- **Key limitation**: Does not do diff generation or planning — if Docteur wants those, it already has them (MetaGPT + external-agents, §1). This is a narrow, surgical tool, not a competing agent.

---

## 5. Comparison matrix

| Candidate | Category | License | Windows | Local models | Repo intelligence | Diff support | Terminal exposure | Git exposure | Sandbox | Telemetry | Integration complexity | Maintenance | Key limitation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Aider | B | Apache-2.0 | Partial (PowerShell repo-map gap, open issue) | YES | AST symbol map | YES | Bounded | **Auto-commit by default** | None | Opt-in | Low-Medium | Active | No apply-approval gate by default |
| Cline | F | Apache-2.0 | YES (native app) | YES | Partial | YES | **Arbitrary** (toggleable auto-approve) | Unrestricted via terminal | None | Opt-out (excludes code/secrets) | Medium | Very active | Arbitrary shell by default |
| OpenHands | C | MIT | **NO (WSL2+Docker mandatory)** | YES | UNKNOWN | YES | Arbitrary (in-container) | Unrestricted (in-container) | Docker | UNKNOWN | High | Active | Windows unsupported — hard reject |
| Continue.dev | A | Apache-2.0 | YES | YES | UNKNOWN | YES | N/A | N/A | N/A | UNKNOWN | N/A | **Archived (dead)** | Dead — hard reject |
| Roo Code | F | Apache-2.0 | YES | YES | UNKNOWN | YES | Arbitrary | Unrestricted | None | UNKNOWN | N/A | **Shut down (dead)** | Dead — hard reject |
| SWE-agent | C | Confirmed present | UNKNOWN (Docker-first) | YES | UNKNOWN | YES | Arbitrary (in-container) | Unrestricted | Docker | UNKNOWN | High | Active | Docker-first, benchmark-oriented, not Docteur's approval shape |
| **Codex CLI** | B | Apache-2.0 | **YES (native sandbox, no WSL needed)** | YES (Responses-API caveat) | UNKNOWN | YES | **Bounded, network-off-by-default** | **`.git` read-only, protected** | **YES — OS-level, strongest reviewed** | UNKNOWN | **Low (partially wired already)** | Active, vendor-backed | Cloud-first; local routing needs a gateway for non-Ollama/LMStudio |
| OpenCode | F | MIT | UNKNOWN | YES | UNKNOWN | YES | Bounded (Plan mode) / Arbitrary (Build mode, non-interactive) | Unrestricted | None documented | Present, opt-out UNKNOWN | Medium (persistent server lifecycle) | Very active | Windows unverified; auto-approve-all in non-interactive mode |
| **Code-Index-MCP** | D | MIT | **YES (documented)** | N/A (tool, not agent) | **YES — AST/symbol, 10 languages** | **No (by design)** | **NO TERMINAL** | **NONE** | N/A (read-only) | UNKNOWN | **Low (stdio MCP)** | Active | Read-only by design — doesn't do diffs (not needed, Docteur has that already) |

---

## 6. Security analysis

**Terminal/shell risk** — ranked from safest to riskiest:
1. Code-Index-MCP: NO TERMINAL at all.
2. Codex CLI: BOUNDED — OS-level sandbox, network off by default, approval-gated escalation.
3. Aider: BOUNDED in practice (chat/edit loop + git commit), but no formal sandbox.
4. OpenCode: BOUNDED in "Plan" mode only; effectively open in "Build"/non-interactive mode.
5. OpenHands / SWE-agent: ARBITRARY but Docker-contained (the container itself has full shell).
6. Cline: ARBITRARY by default, with a toggle that makes it worse (full auto-approve), no sandbox beyond host-process permissions.

**Git destructive-operation exposure**: Only Codex CLI explicitly protects `.git` as read-only inside its sandbox. Aider auto-commits by default (a soft risk — reversible via git, but violates "no automatic git write" preference unless configured off every time). All others (Cline, OpenHands, SWE-agent, OpenCode's Build mode) inherit whatever git commands the underlying arbitrary-shell access allows, with no tool-level distinction between `git status` and `git push --force`.

**Filesystem scope**: Only Codex CLI (workspace + temp, verifiable via `/status`) and Code-Index-MCP (indexing-scope-only, read-only) have a confirmed, documented, bounded filesystem model. Everything else either operates on the full working tree with standard OS-user permissions (Cline, Aider) or full container access (OpenHands, SWE-agent).

**Prompt injection / repository-as-data boundary**: No candidate documents an explicit, structural defense distinguishing "repository content" from "agent instructions" the way MAITRE's SecurityEvent/Analyst boundary or this mission's own KX-9 Kiwix findings do. This is a genuine, unaddressed risk across the entire external coding-agent ecosystem, not specific to any one candidate — any integration would need Docteur to add its own instruction/data boundary on top (e.g., treating any text an agent reads from repository files as inert content, never as new instructions, exactly as `external-agents.js`'s staged-workspace-plus-diff-review pattern already implicitly enforces by never letting agent output bypass human review).

---

## 7. Licensing comparison

| Candidate | License | Commercial use | Notes |
|---|---|---|---|
| Aider | Apache-2.0 | Permitted | No restriction found |
| Cline | Apache-2.0 | Permitted | No restriction found |
| OpenHands | MIT | Permitted | Moot — rejected on Windows grounds |
| Codex CLI | Apache-2.0 | Permitted | Unusual for a vendor-authored tool; no enterprise-only feature gate found |
| OpenCode | MIT | Permitted | No restriction found |
| Code-Index-MCP | MIT | Permitted | No restriction found |
| Continue.dev / Roo Code | Apache-2.0 (both, historically) | Moot | Both archived — no ongoing licensing relevance |

No candidate reviewed carries a hosted-service restriction (no AGPL/SSPL-style clauses encountered) or an enterprise-only feature gate blocking the core functionality evaluated here.

---

## 8. Windows analysis

Per mission §8 (Windows-first requirement):

- **Native, no WSL, no Docker required**: Codex CLI, Code-Index-MCP, Cline (native app).
- **Runs on Windows but with a documented gap**: Aider (PowerShell tree-sitter repo-map support incomplete — functional but degraded for `.ps1` symbol indexing specifically).
- **Unverified**: OpenCode.
- **Requires WSL2 + Docker Desktop (hard reject per mission §34)**: OpenHands.
- **Docker-first, Windows story unclear**: SWE-agent.

---

## 9. Local/cloud analysis

- **Local-first candidates with genuine Ollama/OpenAI-compatible support**: Aider, Cline, Codex CLI (with the Responses-API gateway caveat for non-Ollama/LM-Studio local backends), OpenCode.
- **Cloud-first by nature but Strict-Local-compatible if gated at the call site**: Codex CLI (already has this gating pattern proven via the existing `providers/codex.js` + `checkCloud()`/`isStrictLocalMode()` precedent, §1e of the capability audit).
- **N/A (not a model-calling tool)**: Code-Index-MCP — this is the one candidate that sidesteps the local/cloud question entirely, since it has no model of its own; it just serves indexed repository data to whichever agent (local or cloud) is already permitted to run.

---

## 10. Shortlist (maximum 3, per mission §31)

### 1. Code-Index-MCP (or equivalent MCP repository-indexing server)
- **Best use case**: Filling the one REAL GAP that matters (§2) — symbol/AST-aware source-code search and navigation — without adding any new terminal, git, or apply risk surface.
- **Main risk**: It has no diff/apply capability, so on its own it doesn't look like a complete "Code Intelligence" story; value depends on being paired with something that already has approval-gated apply (which Docteur already has, via `external-agents.js`/MetaGPT).
- **Why it fits Docteur**: MIT, native Windows, fully local/no-network, read-only by construction, stdio MCP (a surface Docteur can adapt behind a single boundary per mission §37), Python (matches the existing MetaGPT Python precedent for auxiliary tooling).
- **Why it may not fit**: It is a narrow indexing tool, not a "provider" in the sense the mission's CI-5 categories (A-D) describe — it's closer to category D taken literally, which the mission explicitly lists as one of the four possible provider models. If the mission intends "provider" to mean a full agent, this candidate under-delivers by design (that under-delivery is exactly why it's safe).

### 2. OpenAI Codex CLI
- **Best use case**: If Docteur wants actual PLAN→DIFF→APPLY coding-agent behavior (not just search), Codex CLI has the strongest sandboxing/approval story of any full agent reviewed, and partial wiring already exists in Docteur (`providers/codex.js`, `external-agents.js`).
- **Main risk**: Cloud-first (OpenAI's own model); local-model routing works only through the Responses-API caveat, meaning "local-first" is not the default posture the way it is for Aider/Cline — would need explicit Strict-Local gating maintained rigorously (which the existing `checkCloud()` pattern already models correctly).
- **Why it fits Docteur**: Native Windows sandbox (no WSL dependency, unlike every autonomous-agent competitor), network-off-by-default, `.git` read-only protection out of the box, Apache-2.0, and — critically — Docteur already imports and gates this exact CLI today via `external-agents.js`, so "integration" would mean *extending* an existing, already-audited boundary rather than building a new one from zero.
- **Why it may not fit**: Duplicates functionality Docteur already has via `external-agents.js` + MetaGPT (diff generation, approval, apply) — the mission's own CI-1 instruction warns against adding a tool "uniquement parce qu'il est populaire" or that duplicates existing capability. Any value-add here is specifically about *upgrading* the existing Codex integration's sandboxing/approval sophistication, not about filling a gap that's currently empty.

### 3. Aider
- **Best use case**: Best local-model story of the full-agent candidates (works well with 32B+ local models per research), strong git-aware multi-file editing via its tree-sitter repo map.
- **Main risk**: Auto-commits by default — a direct, if soft, conflict with the "no automatic git write" preference (mission §11/§21) unless every invocation explicitly passes `--no-auto-commits`, which is easy to forget and has no structural enforcement from Docteur's side unless Docteur's own adapter always injects that flag.
- **Why it fits Docteur**: Apache-2.0, genuinely local-model-native (not cloud-first-with-a-local-option like Codex CLI), simpler integration surface (plain CLI, no persistent server/container).
- **Why it may not fit**: No sandbox, no formal approval gate beyond git's own reversibility, and — like Codex CLI — duplicates diff/apply capability Docteur already has. Its main differentiator (repo map / symbol index) is also what Code-Index-MCP provides more narrowly and more safely.

---

## 11. Provider retained — or NO_INTEGRATION_NEEDED

**Decision: NO_INTEGRATION_NEEDED for a new full coding-agent provider. DEFER Code-Index-MCP-class tooling as a distinct, much smaller future item.**

Reasoning, following mission §33's own selection criteria applied strictly:

- Docteur already has a working PLAN→DIFF→APPROVE→APPLY pipeline **twice over** (MetaGPT for local Ollama-driven new-file generation, `external-agents.js` for staged-workspace Claude/Codex-CLI read/edit with diff review and undo). Adding Aider, Cline, or any of the other full-agent candidates would **duplicate**, not complement, this capability — directly violating mission CI-1's and CI-5's own instructions ("ne pas ajouter un agent uniquement parce qu'il est populaire", "le provider retenu doit compléter, pas dupliquer inutilement").
- The only two REAL GAPS identified (§2) — source-code search/symbol navigation, and read-only git tooling — do not require adopting a full autonomous coding agent. They are better filled by (a) a narrow, read-only MCP indexing tool of the Code-Index-MCP class, and (b) simply adding a few `execFile('git', ['status'|'diff'|'log'|'show', ...], {shell:false})` read-only wrapper calls to Docteur's own codebase, following the exact `maitre-windows-exec.js` "fixed script/args, no shell, no generic command path" precedent already proven safe in this codebase.
- Every full-agent candidate that could plausibly be "the one provider" either fails a hard rejection condition outright (OpenHands: Windows unsupported + Docker-mandatory; Continue.dev and Roo Code: dead/archived) or carries a security posture (arbitrary terminal by default: Cline; no sandbox: Aider; unverified Windows + non-interactive auto-approve-all: OpenCode) that would need substantial Docteur-side wrapping to reach the same safety bar `external-agents.js` already meets today — at which point Docteur would be rebuilding its own existing abstraction around a third-party tool rather than gaining new capability.
- Codex CLI is the one full-agent candidate genuinely worth a closer look later, precisely *because* Docteur already has a live, audited integration point for it (`providers/codex.js`) — but that would be an **enhancement to existing Codex wiring** (e.g., adopting its native-Windows sandbox/approval-mode configuration more deeply), not a new "Code Intelligence provider" integration in the sense this mission is asking about.

This is not a rejection of value — it's a finding that the real gap is narrower and lower-risk than a full agent, and that filling it with a full agent would be over-scoped relative to mission §29's own instruction to prioritize "understanding, search, navigation, planning, diffs" over "autonomie terminal totale."

---

## 12. Proposed future architecture (NOT to be implemented now, per mission §37)

If and when the user validates pursuing the narrow gap-fill identified above, the shape would be:

```
Docteur
  → Code Intelligence Gateway (new, thin adapter — mirrors external-agents.js's boundary discipline)
      → READ_ONLY repository search/index (Code-Index-MCP-class MCP server, stdio, local, no network)
      → READ_ONLY git tooling (status/diff/log/show only — fixed args, no shell, MAITRE-windows-exec precedent)
  (existing, unchanged)
  → external-agents.js (Claude/Codex CLI, staged workspace, diff review, undo) — already does PLAN/DIFF/APPLY
  → metagpt-orchestrator.js (Ollama, local, new-file generation) — already does PLAN/DIFF/APPLY
```

No `APPLY` capability would be added to the new Gateway — apply already exists in the two pipelines above, and duplicating it was the exact outcome this audit recommends against. Strict Local would need no new enforcement work for the read-only-search/git pieces, since they touch no network by construction; a Codex-CLI sandbox enhancement (if separately pursued later) would continue using the existing `checkCloud()`/`isStrictLocalMode()` gate already proven in `external-agents.js`.

---

## DOCTEUR CODE INTELLIGENCE AUDIT CHECKPOINT

Research date: 2026-09-21

Existing Docteur capabilities: MetaGPT (local, Ollama-only, approval-gated plan→diff→apply, new-file-only); `external-agents.js` (Claude/Codex CLI, staged-workspace, diff review + undo, read/edit modes only, Strict-Local-gated); provider abstraction for Claude/Codex CLI text generation with privacy-guard; zero source-code search; zero git read tooling.

Real gaps identified: (1) source-code search/symbol/AST navigation — REAL GAP; (2) read-only git tooling (status/diff/log/show) — REAL GAP. All other candidate gaps (diff generation, apply-with-approval, local-model coding workflows) are ALREADY COVERED by existing Docteur code.

Candidates reviewed: Aider, Cline, OpenHands, Continue.dev, Roo Code, SWE-agent, OpenAI Codex CLI, OpenCode, Code-Index-MCP (repository-intelligence-only class).

Shortlisted candidates: Code-Index-MCP (repo search/symbol nav, no apply), OpenAI Codex CLI (strongest sandbox among full agents, partially already wired), Aider (best local-model full-agent story, but auto-commits by default).

Canonical repositories verified: PASS
Licenses verified: PASS (Apache-2.0 or MIT for every actively-maintained candidate; no hosted-service or enterprise-gate restrictions found)
Windows compatibility reviewed: PASS (OpenHands explicitly fails — WSL2+Docker mandatory; SWE-agent Windows story unclear/Docker-first; OpenCode unverified; all others confirmed compatible with noted caveats)
Local-model compatibility reviewed: PASS
Cloud requirements reviewed: PASS
Repository indexing reviewed: PASS
Terminal exposure reviewed: PASS (ranked NO TERMINAL → BOUNDED → ARBITRARY across all candidates; see §6)
Git exposure reviewed: PASS (only Codex CLI has explicit `.git` protection; Aider auto-commits by default; others inherit unrestricted git via arbitrary shell)
Filesystem exposure reviewed: PASS
Secret exposure reviewed: PARTIAL — no candidate documents an explicit `.env`/secret-store exclusion mechanism; this would need to be enforced by Docteur's own adapter (e.g., never including `.env`/secret-store/cert paths in any context passed to an external agent), regardless of which candidate is eventually used
Prompt-injection risk reviewed: PARTIAL — no candidate documents a structural repository-content-vs-instructions boundary; Docteur would need to enforce this itself (as it already implicitly does via `external-agents.js`'s human-diff-review gate)
Telemetry reviewed: PASS for Aider (opt-in, transparent) and Cline (opt-out but explicitly excludes code/secrets); UNKNOWN and not independently verified for OpenHands, SWE-agent, Codex CLI, OpenCode, Code-Index-MCP
Maintenance reviewed: PASS (Continue.dev and Roo Code confirmed dead/archived and excluded; all shortlisted candidates confirmed actively maintained into 2026)

Recommended provider: **NONE for full-agent integration.** If pursued later: a Code-Index-MCP-class read-only repository indexer, paired with a small hand-written read-only git wrapper — not a "provider" in the agent sense.

Why this provider: The only two real gaps (source search, git read tooling) do not require an autonomous coding agent; Docteur already has two independent, approval-gated diff/apply pipelines, and adding a third would duplicate existing capability against this mission's own explicit CI-1/CI-5 instructions.

Rejected candidates: OpenHands (Windows unsupported, Docker-mandatory — hard reject); Continue.dev (archived/dead — hard reject); Roo Code (archived/dead — hard reject); SWE-agent (Docker-first, benchmark-oriented, not Docteur's approval shape — not shortlisted); Cline (arbitrary terminal by default — security posture conflicts with mission §9/§29); Aider and Codex CLI were shortlisted but not selected, for the duplication reason above, not for a security or licensing failure.

Integration scope: NONE proposed for this phase. A future, separately-scoped, much smaller mission could evaluate adding a read-only MCP repository indexer + read-only git wrapper, per §12's proposed architecture — but that is explicitly a DEFER, not part of this audit's verdict.

Verdict: **NO_INTEGRATION**

Then STOP.

NE PAS COMMENCER L'INTÉGRATION D'UN PROVIDER AUTOMATIQUEMENT. ATTENDRE VALIDATION UTILISATEUR.
