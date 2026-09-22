# DOCTEUR — AGENCY / BUSINESS / TASK AGENTS AUDIT

Research date: 2026-09-21
Scope: audit-only, per mission "PHASE 5 — AGENCY AGENTS AUDIT". No code produced, no packages installed, no external actions taken (0 emails sent, 0 CRM writes, 0 forms submitted, 0 browser logins, 0 purchases, 0 social posts, 0 API keys added).

---

## 1. Existing Docteur capabilities (audited before external research)

### Sherlock Studio — OSINT username checker, not a research agent
`cortex-server/src/routes/sherlock.js` + `sherlock-gateway.js`/`sherlock-policy.js`/`sherlock_runner.py`. Wraps the third-party Sherlock OSINT tool (pinned, SHA-verified fork) to check whether a **username** exists across a small, pinned set of public sites (default 3: GitHub/Reddit/GitLab; max 30 from a frozen, hash-verified site database). Loopback-only, sandboxed subprocess, scrubbed environment, SSRF-hardened egress (only pre-registered probe URLs). **No LLM involvement, no dossier generation, no person/company research.** Results are explicitly flagged `untrusted: true`, and saving OSINT hits as trusted memory is deliberately blocked (`410 osint_results_are_untrusted_data`). This is a narrow, hardened utility — a fundamentally different capability class from a CrewAI/AutoGen-style research agent.

### Investment Studio — deterministic financial analysis + paper trading, with narrow web-research assist
`cortex-server/src/routes/investment.js` + calc/scoring/timeline/policy libs. `POST /investment/research` does real web research (DuckDuckGo HTML search + Playwright/Readability single-page content extraction, capped at 3 pages, each stored as a provenance-tracked source). All financial math (valuation, DCF, scoring) is deterministic — explicitly documented as never LLM-computed. Real-broker actions are hard-stubbed (`403 real_broker_action_denied`, `409 broker_connection_not_supported_in_v1`) — paper trading only, no broker credentials ever handled. Scope is narrowly stock/security-fundamentals — not general business/company/contact research, no CRM-like tracking.

### General research (`research.js`) — an LLM-writes-a-report tool, not an autonomous agent
Gemini-cloud-backed "veille stratégique" writer (synthesis/deep-research/multi-angle document generation), gated by `assertCloudAllowed()`/Strict Local on every route. "Actualité" mode delegates web search to **Gemini's own hosted Google Search grounding** (capped 20/day) — Docteur is not crawling the web itself here. `POST /research/review` has a local-Ollama fallback. No browser automation, no multi-step tool use, no lead-discovery.

### `browser.js` — despite the name, not a browser-automation agent
Only lists installed OS browsers and opens a URL in the user's chosen browser via OS process spawn. No page content access, no scripting, no Playwright involvement.

### Real Playwright usage — confined to a single-page, read-only content extractor
`cortex-server/src/lib/deep-capture.js` (used by investment/capture/corpus/download/web-answer/web-explore): headless Chromium, navigates to one URL, runs Readability to extract article text, used only as a fetch-fallback when a fast HTTP GET yields too little text. **No clicking, no form-filling, no login/session handling, no multi-step navigation.**

### MetaGPT and `external-agents.js` — confirmed coding-only
Both re-confirmed (matching Phase 4's audit) to have no non-coding mission/job mode anywhere. Neither has any business-task prompt template or CRM/email/calendar tool binding.

### Provider architecture, Strict Local, secret-store — unchanged
`isStrictLocalMode()`/`assertCloudAllowed()` (`cortex-server/src/lib/strict-local.js`) confirmed present and actively gating `research.js` (7 call sites). DPAPI secret-store confirmed unchanged.

### Approvals — no shared primitive, confirmed still absent
Five independent verticals (MAÎTRE, MetaGPT, ExternalAgents, plus Sherlock and Investment which need none) each with their own hand-rolled approval logic where relevant. No shared `approval-common.js` exists.

### Feature Registry / Command Center
`src/content/capabilities.ts`'s `HELP_DIRECTORY` confirmed to already register both `'sherlock'` and `'investment'` as `FeatureKey` entries with `state: 'local'` — this is the established pattern any future Business/Sales Studio would need to follow (new `FeatureKey` literal + `HelpFeature` entry + `App.tsx` wiring).

### "Planned OMEGA" / "Planned RASSILON" — not found anywhere in the project
A full case-insensitive repo grep (excluding `node_modules`/`external/`/`.git`/build caches) found **zero matches for "RASSILON"**, and the only "OMEGA" matches are unrelated false positives (a bundled icon-library component name, and an unrelated video transcript about the watch brand Omega). `reports/MAITRE_FUTURE_WORK_2026-09.md` — the most likely place such a roadmap item would live — contains a detailed V1.1/V2/research backlog with no mention of either name. **These are not real internal Docteur roadmap items as far as this repository's own history and documentation show.** If they were mentioned to you from outside this audit, that information did not originate from this codebase and should be verified independently before being treated as fact.

### Email / CRM / Calendar — confirmed absent
No SMTP/nodemailer, no calendar library, no CRM SDK anywhere in `cortex-server/src` or `src/`. One incidental string match in `connector-registry.js` appears to be a category label, not a functional integration (not independently opened to confirm, flagged here rather than asserted).

---

## 2. Business gaps — classified

| Capability | Classification | Notes |
|---|---|---|
| Lead discovery | **REAL GAP** | Nothing in Docteur discovers companies/people matching a target profile |
| Company research | PARTIAL | Investment Studio does narrow stock-symbol research only; nothing general-purpose |
| Contact enrichment | **REAL GAP** | No capability to resolve a person/company to contact details |
| Sales research | **REAL GAP** | No sales-specific research workflow exists |
| Market mapping | **REAL GAP** | Nothing maps competitors/market landscape |
| Competitor research | **REAL GAP** | Not covered by any existing Studio |
| Outreach drafting | **REAL GAP** | No email/message drafting capability at all |
| CRM-style notes | **REAL GAP** | No CRM concept exists anywhere |
| Follow-up preparation | **REAL GAP** | No task/reminder/follow-up tracking |
| Workflow planning | PARTIAL | MetaGPT plans (coding only); no general business-task planner |
| Internal business tasks | **REAL GAP** | Nothing addresses operations/internal workflow orchestration |
| Multi-step browser automation | **REAL GAP** | Only single-page read-only extraction exists; no form-filling, login, or click-through navigation anywhere |
| Cross-studio task orchestration | **REAL GAP** | Five independent verticals, no shared agent/graph abstraction |

**Net finding**: essentially every business-agency capability the mission lists is either a REAL GAP or, at best, narrowly PARTIAL via Investment Studio's stock-specific research. This differs sharply from Phase 4's Code Intelligence finding (where most of the value was already covered) — here, almost nothing overlaps.

---

## 3. Research methodology

Web search + direct fetch of official repositories, documentation, and license/security-disclosure pages, dated 2026-09-21. Prioritized canonical GitHub orgs, official docs, and CVE/security-review sources over marketing pages.

---

## 4. Candidates evaluated

### Category key
A = Agent framework · B = Business/sales agent · C = Browser agent · D = Workflow orchestrator · E = Multi-agent framework · F = Hosted SaaS · G = Library/SDK

### CrewAI
- **Category**: A/E (agent framework, multi-agent orchestration — "Crews" and "Flows")
- **Canonical repository**: github.com/crewAIInc/crewAI
- **Latest stable release**: v1.14.3 (2026-04-24), 54k+ stars
- **License**: Plain MIT, no additional restrictions (verified directly against the LICENSE file)
- **Commercial use**: Permitted
- **Windows support**: UNKNOWN — no explicit native-Windows confirmation found; Python-based, likely runs but no verified native-vs-WSL distinction found
- **Runtime**: Python
- **Docker required?**: No (optional; was previously used for the now-removed Code Interpreter sandbox — see Security below)
- **Local model support**: YES, via LiteLLM-style provider flexibility
- **Cloud model support**: YES
- **Ollama support**: YES (via provider flexibility)
- **OpenAI-compatible support**: YES
- **Browser/Email/Calendar/CRM/Filesystem/Shell/Code execution**: all available as tools depending on what the developer wires in — CrewAI itself is tool-agnostic; risk is entirely in what a deployer attaches
- **MCP/tools**: YES
- **Memory**: YES, built-in memory system (not independently verified for encryption/local-only guarantees)
- **Multi-agent orchestration**: YES — core feature (Crews = collaborative roles, Flows = event-driven control)
- **Human approval model**: `requires_human_approval=True` per-tool opt-in flag; CrewAI Enterprise (commercial) adds a fuller HITL management layer (review, escalation, SLA) — the **open-source core has no approval-by-default**, it's opt-in per tool
- **Telemetry**: Opt-in (`share_crew` attribute), off by default for detailed execution data
- **Network requirements**: to whatever LLM/tool endpoints are configured
- **Secret handling**: UNKNOWN — no explicit `.env`/credential-isolation guarantee documented
- **Maintenance**: Active, well-maintained (54k+ stars, frequent releases)
- **Security disclosure (critical finding)**: **CVE-2026-2275 and CVE-2026-2287** — the bundled Code Interpreter tool's Docker sandbox had a silent, undocumented fallback to an in-process Python "sandbox" (escapable via arbitrary C function calls) when Docker wasn't available or a config flag was set, combined with prompt injection as the practical attack vector, enabling RCE on the host. **Patched by removing the fallback entirely** — CrewAI now directs users to external sandboxing (E2B/Daytona) instead of a bundled implementation. Independent security review states plainly: CrewAI's open-source core ships with **"no built-in authentication, no audit logging, and no access control"** — every security boundary must be built by the deployer.
- **Integration complexity**: LOW to wire up minimally, but HIGH to reach Docteur's actual safety bar, since none of MAÎTRE/MetaGPT/ExternalAgents' hash-bound-TTL-approval, sandboxed-execution, or audit-logging discipline exists in the framework itself.

### Microsoft Agent Framework (successor to AutoGen + Semantic Kernel)
- **Category**: A/E (agent framework, multi-agent orchestration, enterprise-oriented)
- **Canonical repository**: github.com/microsoft/agent-framework
- **Latest stable release**: v1.0 (2026-04-03), stable APIs, Microsoft LTS commitment
- **License**: MIT
- **Commercial use**: Permitted
- **Windows support**: Strong — Microsoft-developed, .NET-first support alongside Python, no WSL/Docker dependency documented for basic use
- **Runtime**: .NET and Python (Go SDK also exists, separate repo)
- **Docker required?**: No
- **Local model support**: Multi-provider model support documented; Ollama/local endpoint compatibility plausible via its provider abstraction (not independently confirmed to the same granular detail as CrewAI's LiteLLM story)
- **Cloud model support**: YES, native (Azure AI Foundry integration, plus general multi-provider support)
- **Browser/Email/CRM/etc.**: Tool-agnostic, same as CrewAI — risk is in what's attached
- **MCP/tools**: YES, native MCP and A2A (agent-to-agent) protocol support
- **Multi-agent orchestration**: YES — this is the direct successor unifying AutoGen's orchestration model with Semantic Kernel's enterprise features
- **Human approval model**: **First-class, structurally designed in** — `DelegatingChatClient` middleware pattern intercepts tool calls before execution, surfaces them for human review, and treats rejection as first-class model feedback (not just an error). Documented approval-gating criteria explicitly mirror this mission's own concerns: side effects (data modification, communications, purchases), data sensitivity (PII/financial), reversibility, and scope of impact (bulk operations). Includes a "don't ask again" option and pre-wired OpenTelemetry-based approval audit trail.
- **Telemetry**: Present, OpenTelemetry-based; wired into an AG-UI event stream — opt-out mechanism not independently verified in this pass
- **Maintenance**: Very active, Microsoft-backed, explicit LTS commitment, frequent 2026 releases (public preview Oct 2025 → RC Feb 2026 → v1.0 Apr 2026)
- **Security disclosure**: None found in this research pass (absence of finding, not a confirmed clean bill)
- **Integration complexity**: MEDIUM — larger, more enterprise-oriented surface than CrewAI, but the built-in approval-middleware pattern is structurally closer to what Docteur would otherwise have to build from scratch.

### LangGraph (LangChain ecosystem)
- **Category**: D/G (low-level workflow/state-graph orchestrator, library — explicitly positioned as infrastructure, not a batteries-included agent)
- **Canonical repository**: github.com/langchain-ai/langgraph
- **License**: MIT
- **Commercial use**: Permitted
- **Windows support**: Cross-platform Python library; no Windows-specific blocker found, no explicit native confirmation either
- **Runtime**: Python (also a JS/TS variant exists in the broader LangChain ecosystem, not independently verified here)
- **Docker required?**: No for the library itself; Docker is one deployment option for the optional "Agent Server"
- **Local model support**: YES, via LangChain's broad model-provider abstraction (Ollama supported)
- **Cloud model support**: YES
- **Human approval model**: **First-class, structurally designed in** — the `interrupt()` / `Command(resume=...)` pattern pauses graph execution at a chosen point, persists state via a checkpointer, and hands control back to a human who can approve-as-is, edit-then-approve, or reject-with-feedback. Explicitly documented best practice: "interrupt on irreversible, high-blast-radius actions only." This is arguably the cleanest approval primitive of the three orchestration frameworks reviewed — closer in spirit to MAÎTRE's own approval discipline than CrewAI's bolt-on flag.
- **Telemetry**: LangSmith tracing is **enabled by default**, sending prompt/graph-state data externally unless explicitly disabled (`LANGSMITH_TRACING=false`, `LANGGRAPH_CLI_NO_ANALYTICS=1`). This is a real default-on data-egress concern for a framework otherwise marketed as infrastructure-only.
- **Maintenance**: Very active, widely adopted (cited production users: Klarna, Replit, Elastic)
- **Integration complexity**: LOW-MEDIUM as a pure orchestration library (no bundled tool-execution sandbox risk the way CrewAI's Code Interpreter had, since LangGraph itself doesn't ship one) — but every tool/action still needs Docteur-side wrapping exactly like the other two.

### Browser Use (browser-use/browser-use)
- **Category**: C (browser automation agent framework)
- **Canonical repository**: github.com/browser-use/browser-use
- **License**: MIT
- **Windows support**: Not independently verified as native-vs-WSL in this pass; Python-based (`uv add browser-use`)
- **Maintenance**: Extremely active — 10,295+ commits, 115.8k+ stars, "BU 2.0" model shipped Jan 2026 with a state-of-the-art 89.1% WebVoyager success rate
- **Local model support**: YES, via Ollama (subject to hardware/model capability)
- **Cloud model support**: YES
- **Security (critical finding)**: Can control **real browsers reusing the user's existing Chrome profile, including cookies and active sessions** (`Browser.from_system_chrome()`), in addition to isolated instances. **No documented built-in restriction against navigating to login pages, entering credentials, or submitting forms**, and **no documented human-approval/confirmation step before an action** in the base framework. This is a direct, confirmed match to the exact risk mission §11 warns against ("un browser agent ne doit pas obtenir par défaut l'accès aux sessions privées de l'utilisateur").
- **Docker required?**: No
- **Integration complexity**: capability is powerful and well-maintained, but the default posture is the opposite of what Docteur would want — isolation and approval gating would have to be bolted on entirely by Docteur, with the framework's own documented default (reuse real profile) working directly against that goal unless explicitly configured away every time.

### Skyvern / Stagehand (noted, not deeply profiled)
Surfaced during research as competitive browser-automation agents (Skyvern: 85.85% WebVoyager, leads on form-filling specifically). Not independently profiled to the same depth as Browser Use since the category-level finding (powerful web automation with no default isolation from the user's real session/credentials) applies to this whole class of tool, not to one implementation specifically. Any of these would need the same Docteur-side isolation/approval wrapping.

### Sales/business-agent candidates (mission §25 — "Harvey-like")
Evaluated three specifically, per mission's explicit instruction to research this category:

- **SalesGPT** (filip-michalsky/SalesGPT) — MIT license, LiteLLM-based (50+ model support). **Rejected outright**: documented to autonomously generate Stripe payment links to sell products and perform "automated email communication" for outreach — a direct match to two of the mission's explicitly forbidden capabilities (§7: "automated purchases"/financial commitments, "automatic email sending").
- **OpenOutreach** (eracle/OpenOutreach) — GPLv3, self-hosted CLI. **Rejected outright**: sends outreach emails automatically from the user's real mailbox after lead qualification (pacing/cap "guards" exist but the send itself is not human-approval-gated by default) — a direct match to the same forbidden "automatic email sending" capability, plus requires a paid third-party lead-data API (BetterContact) and real SMTP/IMAP mailbox credentials.
- **sales-outreach-automation-langgraph** (kaymen99) — license not confirmed in this pass (LICENSE file lookup returned 404; flagged as UNKNOWN rather than assumed). **The one candidate in this category that is architecturally aligned with the mission**: drafts personalized outreach emails and research reports for explicit human review rather than sending automatically; researches leads via LinkedIn/company websites/news; integrates with HubSpot/Airtable/Google Sheets as CRMs. Built on LangGraph, inheriting its `interrupt()`-based approval primitive. **Not a finished product** — a reference implementation/example repo, not a maintained framework with releases; would serve better as an architecture reference than as something to adopt wholesale.

**Conclusion for this category**: every actual "sends real outreach" open-source sales agent found defaults to autonomous sending — this appears to be closer to the norm than the exception in this specific product category, reinforcing why the mission's explicit "DRAFT possible, SEND requires explicit confirmation, 0 automatic bulk send" boundary is a real, necessary constraint rather than a theoretical one.

---

## 5. External action boundary — tool-by-tool, across all candidates reviewed

| Tool | What's typically offered | Read | Draft | Propose | Write | Send | Purchase |
|---|---|---|---|---|---|---|---|
| EMAIL | SMTP/IMAP integration (OpenOutreach, SalesGPT) | — | possible | possible | — | **default-on in both dedicated sales agents reviewed** | n/a |
| CRM | HubSpot/Airtable/Sheets (LangGraph sales example) | possible | — | — | **appears default-on (status/link updates)** | n/a | n/a |
| BROWSER | Full page control incl. real user session (Browser Use) | possible | n/a | n/a | possible (form fill) | possible (form submit) | **possible — no built-in block** |
| FILES | Framework-dependent, usually unrestricted within process permissions | possible | possible | possible | possible | n/a | n/a |
| SHELL/CODE | CrewAI Code Interpreter (had CVE), general frameworks assume dev wires in whatever | n/a | n/a | n/a | n/a | n/a | n/a — but RCE was the actual 2026 CVE outcome |
| PAYMENTS | SalesGPT (Stripe link generation) | n/a | n/a | n/a | n/a | n/a | **default-on, no approval gate documented** |
| MESSAGING | Framework-dependent | possible | possible | possible | possible | framework-dependent | n/a |

**Conclusion**: none of the frameworks or ready-made agents reviewed default to Docteur's desired READ/DRAFT-by-default, WRITE/SEND/PURCHASE-requires-approval boundary. The two orchestration frameworks with genuine first-class approval primitives (LangGraph's `interrupt()`, Microsoft Agent Framework's `DelegatingChatClient` middleware) provide the *mechanism* to build that boundary, but the boundary itself is not their default — it would need to be Docteur's own policy layer on top, exactly as MAÎTRE/MetaGPT/ExternalAgents already each independently do today.

---

## 6. Email security (mission §9)

Both dedicated sales-agent products reviewed (SalesGPT, OpenOutreach) **send real emails from a real mailbox by default**, with only pacing/rate-limiting as a safety measure — not draft/send separation. Neither documents recipient validation beyond the lead-qualification step, attachment handling policy, or HTML-injection defenses for outreach content. This is a genuine, demonstrated risk class, not a hypothetical: a Docteur-built Sales Studio must never adopt either of these products' default behavior. The LangGraph-based reference implementation is the only email-touching candidate that matches Docteur's required DRAFT-then-human-review model.

## 7. CRM security (mission §10)
No candidate reviewed documents a clean READ/CREATE-NOTE/EDIT-CONTACT/DELETE/PIPELINE-CHANGE separation. The LangGraph sales-outreach example appears to write CRM status/links as part of its normal flow without a distinct approval step for that specific action (separate from the email-draft-for-review step) — this would need to be added by Docteur, not assumed present.

## 8. Browser agent risk (mission §11)
Confirmed as a first-order concern: Browser Use (the strongest-maintained candidate in this category) can reuse the real user's Chrome profile with live cookies/sessions by design, with no documented default restriction on login pages, credential entry, or form submission. Any future Docteur browser-agent capability must run in an isolated browser context by default (never the user's real profile) and must never be handed real site credentials.

## 9. Prompt injection (mission §12)
No candidate reviewed documents a structural, enforced boundary distinguishing external content (web pages, emails, CRM notes, search results) from agent instructions — this matches Phase 4's finding for coding agents. CrewAI's own 2026 CVEs are a concrete instance of prompt injection being the practical trigger for a real vulnerability (steering the agent into invoking the unsafe sandbox fallback). Any future business-agent capability in Docteur must treat all such content as inert data, exactly as MAÎTRE and Sherlock already do (Sherlock's explicit `untrusted: true` tagging and refusal to persist OSINT hits as trusted memory is a good internal precedent to reuse).

## 10. Secret handling (mission §13)
No candidate reviewed documents a secret-isolation guarantee comparable to Docteur's existing DPAPI secret-store. Any future integration (email/CRM API tokens, lead-data-provider API keys) would need to go through the existing secret-store pattern, not a framework-provided credential store.

## 11. Local/cloud distinction (mission §14)
All three orchestration frameworks (CrewAI, Microsoft Agent Framework, LangGraph) are "local-runnable" in the sense that the framework code itself runs on-machine and can be pointed at Ollama — but none is local-only by nature; all assume a configurable cloud LLM as the common case. This mirrors Phase 4's Codex CLI finding: an open-source framework is not automatically "local-first" just because it's self-hostable.

## 12. Strict Local compatibility (mission §15)
None of the reviewed frameworks has a built-in "Strict Local" concept. If any were adopted, Strict Local enforcement would need to be Docteur's own gate wrapped around every model call and every external-action tool (email/CRM/browser/purchases) — following the exact `isStrictLocalMode()`/`assertCloudAllowed()` pattern already proven across `research.js`, `external-agents.js`, and the cloud providers. LangGraph's default-on LangSmith telemetry is a specific, concrete leak this gate would need to explicitly disable (`LANGSMITH_TRACING=false`) rather than assume off.

## 13. Windows-first (mission §16)
None of the three orchestration frameworks (CrewAI, Microsoft Agent Framework, LangGraph) documents a WSL or Docker requirement for basic use — all are pure Python/.NET libraries. Microsoft Agent Framework has the strongest confirmed Windows story (Microsoft-developed, .NET-first). Browser Use and the sales-agent products are Python CLIs/libraries with no documented Windows blocker either, though none was found to have explicit native-Windows confirmation the way Codex CLI did in Phase 4.

## 14. Shell/code execution (mission §17)
CrewAI is the only candidate with a documented history of shell/code-execution risk materializing as a real CVE (the Code Interpreter's silent sandbox-fallback RCE). The framework's own fix was to remove the bundled sandbox entirely rather than harden it — Docteur should read this as a signal to never bundle a "sandbox" claim from a third-party framework without independent verification, and to keep code execution scoped to Docteur's own already-audited patterns (MetaGPT's Python-runner subprocess model, MAÎTRE's semantic-dispatch-only executor) rather than a framework's bundled interpreter tool.

## 15. Multi-agent delegation risk (mission §18)
None of the three frameworks documents an explicit "a sub-agent can never exceed its parent's permissions" guarantee — CrewAI's Crews/Flows and Microsoft Agent Framework's multi-agent orchestration both allow agents to invoke other agents/tools, and permission scoping across that delegation would be entirely up to how Docteur wires tool access per-agent, not something enforced by the framework itself.

## 16. Memory (mission §19)
CrewAI has a built-in memory system; encryption/local-only/user-clearable guarantees were not independently verified. No candidate was confirmed to have a per-project memory-scoping guarantee comparable to what Docteur would need to avoid cross-agent leakage.

---

## 17. Comparison matrix

| Candidate | Category | License | Windows | Local models | Cloud dependency | Browser | Email | CRM | Shell | Approval model | Telemetry | Maintenance | Integration complexity | Main risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CrewAI | A/E | MIT | Unverified | YES | Optional (LiteLLM) | Tool-dependent | Tool-dependent | Tool-dependent | Had CVE (fixed) | Opt-in per-tool flag; no default gate | Opt-in | Active | Low-to-wire, high-to-secure | 2026 RCE CVE; "no built-in access control" by own admission |
| Microsoft Agent Framework | A/E | MIT | Strong (native) | Plausible | Native (Azure) + multi-provider | Tool-dependent | Tool-dependent | Tool-dependent | Tool-dependent | **First-class middleware, designed for exactly this** | Present, OpenTelemetry | Very active, MS LTS | Medium | Enterprise-oriented surface larger than needed for Docteur's scope |
| LangGraph | D/G | MIT | Unverified | YES (Ollama) | Optional | Tool-dependent | Tool-dependent | Tool-dependent | Tool-dependent | **First-class `interrupt()`, closest to MAÎTRE's own discipline** | **Default-ON (LangSmith)** | Very active | Low-Medium | Default telemetry egress must be explicitly disabled every time |
| Browser Use | C | MIT | Unverified | YES (Ollama) | Optional | **Full, real-session-capable by default** | No | No | No | **None documented by default** | Unverified | Extremely active | Medium | Can reuse real browser profile/cookies/sessions with no default isolation |
| SalesGPT | B | MIT | Unverified | Via LiteLLM | Yes | No | **Auto-send by default** | Unverified | No | None for send/purchase | Unverified | Unverified (2026 activity unconfirmed) | N/A — rejected | Autonomous Stripe payment link generation; auto email send |
| OpenOutreach | B | GPLv3 | Unverified | No (cloud LLM only) | Yes, plus paid lead-data API | No | **Auto-send by default** | No | No | Pacing/caps only, not approval-gated | Unverified | Active (1,043 commits) | N/A — rejected | Auto-sends from real mailbox; requires real SMTP credentials |
| sales-outreach-automation-langgraph | B (reference impl.) | UNKNOWN (404 on LICENSE) | Unverified | Via LangGraph | Yes | No | **Draft-only, human-reviewed** | Writes status (unclear if gated) | No | Inherits LangGraph `interrupt()` | Inherits LangGraph default | Reference repo, not a maintained product | N/A — architecture reference only | Not a finished/maintained framework; license unconfirmed |

---

## 18. Shortlist (maximum 3, per mission §29)

### 1. LangGraph (as an architecture reference / potential thin orchestration layer, not adopted wholesale)
- **Best use case**: If Docteur ever builds a multi-step business-research workflow (research → analyze → score → draft), LangGraph's `interrupt()` primitive is the cleanest match found for pausing at exactly the "propose vs. apply" boundary Docteur already enforces elsewhere.
- **Main risk**: Default-on LangSmith telemetry (must be explicitly disabled every time); adds a real dependency (LangChain ecosystem) for what might be achievable with a much smaller Docteur-authored state machine, given the codebase already has five independent hand-rolled orchestration/approval patterns that work.
- **Why it fits**: MIT, local-model-compatible, lowest-complexity of the three real frameworks, and its core approval concept (interrupt on irreversible/high-blast-radius actions only) already matches Docteur's own stated philosophy.
- **Why it may not fit**: Docteur doesn't need a generic graph-orchestration library — it needs specific business-research capabilities (lead discovery, company profiling, draft outreach) that LangGraph itself doesn't provide; adopting it would mean building all of that from scratch on top of it anyway, at which point the framework's marginal value over a thin Docteur-authored orchestrator is unclear.

### 2. Microsoft Agent Framework (noted for its approval-middleware design, not recommended for adoption now)
- **Best use case**: If Docteur's business-agent needs grow into genuinely complex multi-agent delegation with enterprise-grade audit requirements, this framework's middleware-based approval pattern (keyed on side-effects/sensitivity/reversibility/scope — the exact same axes this mission itself uses) is the most structurally aligned of anything reviewed.
- **Main risk**: Substantially larger and more enterprise-oriented than anything Docteur's V1 business-agent scope would need; adds a .NET/Python cross-runtime surface where Docteur's existing stack is Node+Python only.
- **Why it fits**: MIT, strong native Windows story, Microsoft LTS commitment (low abandonment risk), designed-in approval gating.
- **Why it may not fit**: Overkill relative to the mission's own stated V1 scope (RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW) — this framework is built for production multi-agent enterprise systems, not a single Studio's research-and-draft workflow.

### 3. sales-outreach-automation-langgraph (as a design reference only, not a dependency)
- **Best use case**: A concrete, already-built example of exactly the DRAFT-not-SEND, research-to-CRM-note workflow shape Docteur's mission asks about — useful to read for architecture ideas (what fields a lead-research dossier should have, how a CRM-note draft should be structured) without adopting it as a dependency.
- **Main risk**: Not a maintained framework — it's a single-author reference repository with unconfirmed license; treating it as production-ready infrastructure would be a mistake.
- **Why it fits**: It's the only "sales agent" found in this research pass that actually matches the mission's own explicit V1-acceptable/non-acceptable boundary (draft yes, autonomous send no).
- **Why it may not fit**: Using someone's example project as a base for a real feature (rather than pure inspiration) would import unverified-license code and an unmaintained dependency — the same "no vendor fork of a large tier-3 project" caution this session's Code Intelligence audit already established.

---

## 19. Value vs. complexity (mission §27)

For every serious candidate: the **new capability** (lead discovery, outreach drafting, CRM notes) is real and currently entirely missing from Docteur. But the **security cost** of any ready-made framework is non-trivial — CrewAI has a real CVE history and admits no built-in access control; the two actual sales-agent products both default to real-world side effects (sending email, generating payment links) that directly violate this mission's own explicit boundary; Browser Use's real-session-reuse default is a direct match to the exact risk mission §11 warns against. None of this is a reason to avoid the *capability* — it's a reason to build the *policy layer* (READ/DRAFT default, WRITE/SEND/PURCHASE behind approval, Strict-Local-gated cloud calls, untrusted-content tagging) as Docteur's own code, reusing existing primitives (MAÎTRE's hash-bound approval pattern, Sherlock's `untrusted: true` tagging, the DPAPI secret-store, `isStrictLocalMode()`), around a **small, purpose-built tool set** rather than importing a large general-purpose framework's much broader (and, per CrewAI's own admission, largely unguarded) surface.

---

## 20. Recommendation

**BUILD_THIN_DOCTEUR_AGENT** (mission §26 category C), not framework integration.

Reasoning:
- The business gaps identified (§2) are real and numerous — this is not a "nothing to add" verdict like Phase 4's Code Intelligence audit.
- But every ready-made framework/agent reviewed either (a) has a demonstrated security weakness (CrewAI's CVE + explicit no-built-in-access-control admission), (b) defaults to exactly the external actions this mission explicitly forbids (SalesGPT and OpenOutreach both auto-send; Browser Use defaults to real-session reuse), or (c) is architecturally sound but disproportionately large for the actual V1 scope needed (Microsoft Agent Framework; LangGraph as a full dependency rather than an inspiration).
- Docteur already has the individual pieces a thin business-research agent needs, proven and working: a deterministic approval-and-audit pattern (MAÎTRE), a diff-review-before-apply pattern (MetaGPT/ExternalAgents), a research-with-provenance pattern (Investment Studio's `/research` endpoint — DuckDuckGo search + Readability extraction + stored sources), an untrusted-external-data-tagging convention (Sherlock's `untrusted: true`), Strict Local gating (`isStrictLocalMode()`), and a DPAPI secret-store. A thin Docteur-authored orchestrator over these existing pieces, plus a small set of new tools (company/lead research reusing Investment Studio's research pattern, draft-only outreach composition, CRM-style note generation stored locally), would deliver the mission's V1 scope without importing any of the frameworks' broader unguarded surface.
- This mirrors the Phase 4 (Code Intelligence) conclusion's spirit even though the verdict differs: there, existing capability already covered the gap; here, existing *patterns* (not capability) cover the safety-critical parts, and only the business-domain-specific pieces (lead research, outreach drafting) are genuinely new and small enough to build directly.

---

## 21. Proposed future V1 scope (NOT to be implemented now)

Per mission §31, if a future Docteur Business/Sales Studio is pursued:

```
RESEARCH (reuse Investment Studio's existing web-search + Readability-extraction +
          provenance-tracked source pattern, generalized beyond stock symbols)
  → ANALYZE (deterministic classification/scoring, same "never let an LLM compute
             the number, only interpret one already computed" discipline as
             investment-calc.js)
  → SCORE (relevance classification against a user-defined target profile)
  → DRAFT (outreach message / CRM-style note — text only, never sent/written anywhere)
  → HUMAN REVIEW (mandatory before any external effect)
```

Explicitly NOT in V1 scope: automatic email sending, mass outreach, CRM auto-writes, social posting, purchases, financial commitments, contract acceptance, account creation — matching mission §7's forbidden-functions list exactly. Any WRITE/SEND/PURCHASE capability, if ever added beyond V1, would need its own MAÎTRE-style hash-bound approval gate, never a framework-provided one.

---

## 22. Known limitations of this audit

- "OMEGA" and "RASSILON" (named in the mission's own §2 instruction as things to check for overlap) were **not found anywhere in the Docteur codebase or its reports** — treated here as not-yet-real planned features rather than confirmed roadmap items; flagged explicitly rather than silently assumed.
- `sales-outreach-automation-langgraph`'s license could not be confirmed (LICENSE file returned 404) — marked UNKNOWN rather than assumed permissive.
- Windows-native-vs-WSL status for CrewAI, LangGraph, and Browser Use was not independently confirmed to the same depth Phase 4 achieved for Codex CLI — all appear to be plain Python libraries with no documented Windows blocker, but no explicit "tested natively on Windows" confirmation was found either.
- `connector-registry.js`'s single "crm" string match was not independently opened to rule out a partial/stub CRM reference — flagged as worth a direct follow-up read if precision matters, not treated as a confirmed integration.
- Skyvern and Stagehand (browser agents) were noted but not profiled to the same depth as Browser Use, since the category-level finding (no default session isolation) was judged to apply broadly rather than needing per-tool re-verification.

---

## DOCTEUR AGENCY AGENTS AUDIT CHECKPOINT

Research date : 2026-09-21

Existing Docteur agency capabilities : Sherlock (narrow OSINT username-checker, untrusted-tagged, no LLM), Investment Studio (deterministic financial analysis + paper trading, narrow stock-symbol web research via DuckDuckGo+Readability), research.js (Gemini-backed report-writing tool with search grounding, not an autonomous agent), MetaGPT and external-agents.js (both confirmed coding-only). No cross-studio orchestration layer exists.

Business gaps : lead discovery, contact enrichment, sales research, market mapping, competitor research, outreach drafting, CRM-style notes, follow-up preparation, general business-task workflow planning, multi-step browser automation — all REAL GAP. Company research and workflow planning are PARTIAL (narrowly covered by Investment Studio and MetaGPT respectively, neither general-purpose).

Candidates reviewed : CrewAI, Microsoft Agent Framework, LangGraph, Browser Use (+ Skyvern/Stagehand noted), SalesGPT, OpenOutreach, sales-outreach-automation-langgraph.

Shortlisted candidates : LangGraph (architecture reference for its `interrupt()` approval primitive), Microsoft Agent Framework (noted for its middleware approval design, not recommended for adoption), sales-outreach-automation-langgraph (design reference only, not a dependency — unmaintained single-author repo).

Canonical repos verified : PASS

Licenses verified : PASS (MIT confirmed for CrewAI, Microsoft Agent Framework, LangGraph, Browser Use, SalesGPT; GPLv3 confirmed for OpenOutreach; UNKNOWN for sales-outreach-automation-langgraph — LICENSE file not found, not assumed)

Windows compatibility : PARTIAL (Microsoft Agent Framework strongly confirmed; others plausible/unverified, no Windows blocker found for any)

Local model compatibility : PASS (CrewAI, Microsoft Agent Framework, LangGraph, Browser Use all support Ollama/local models; SalesGPT via LiteLLM; OpenOutreach cloud-LLM-only)

Cloud dependencies : all three orchestration frameworks are cloud-optional (local-capable but not local-only by nature); SalesGPT and OpenOutreach both require cloud LLM + external paid services

Browser exposure reviewed : PASS — Browser Use confirmed capable of reusing the real user's browser profile/cookies/sessions by default, with no documented built-in restriction on credential entry or form submission; this is a direct, confirmed match to the risk mission §11 warns against

Email exposure reviewed : PASS — both SalesGPT and OpenOutreach confirmed to send real emails automatically by default; the one draft-only reference implementation is not a maintained product

CRM exposure reviewed : PARTIAL — no candidate documents a clean READ/CREATE-NOTE/EDIT/DELETE separation; the one CRM-touching example appears to write status without a distinct approval step

Shell/code exposure reviewed : PASS — CrewAI's 2026 CVE (sandbox-fallback RCE, prompt-injection-triggered) is the concrete, documented instance of this exact risk class; framework's own fix was to remove the bundled sandbox rather than harden it

Secret handling reviewed : PARTIAL — no candidate documents a secret-isolation guarantee comparable to Docteur's existing DPAPI secret-store; would need to be Docteur's own layer regardless of any framework choice

Prompt injection reviewed : PASS — no candidate has a structural data-vs-instruction boundary; CrewAI's CVE is direct evidence this is an active, exploited risk class, not a theoretical one

Human approval support : PARTIAL — LangGraph (`interrupt()`) and Microsoft Agent Framework (`DelegatingChatClient` middleware) both have genuine first-class approval primitives; CrewAI's is a bolt-on opt-in flag; the two actual sales-agent products have none for their highest-risk actions (send/purchase)

Telemetry reviewed : PARTIAL — CrewAI opt-in (off by default); LangGraph's LangSmith tracing is default-ON and must be explicitly disabled; Microsoft Agent Framework's OpenTelemetry opt-out status unverified; Browser Use and the sales agents unverified

Maintenance reviewed : PASS — CrewAI, Microsoft Agent Framework, LangGraph, and Browser Use all confirmed actively maintained into 2026 with recent releases; sales-outreach-automation-langgraph is a reference repo, not a maintained product (noted, not rejected on this basis since it was only ever proposed as inspiration)

Recommended architecture : BUILD_THIN_DOCTEUR_AGENT — a small, Docteur-authored orchestrator reusing existing patterns (MAÎTRE's approval discipline, MetaGPT/ExternalAgents' diff-before-apply model, Investment Studio's provenance-tracked research pattern generalized beyond stock symbols, Sherlock's untrusted-data tagging convention, Strict Local gating, DPAPI secret-store) plus a small set of new business-research-specific tools — not adoption of any external framework.

Recommended framework : NONE (LangGraph and Microsoft Agent Framework noted as design references for their approval-primitive patterns; neither recommended for actual adoption)

Recommended Business/Sales V1 scope : RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW, matching mission §31 exactly; explicitly excludes automatic email send, CRM auto-write, social posting, purchases, financial commitments, contract acceptance, account creation.

Automatic email sending recommended : 0

Automatic CRM writes recommended : 0

Automatic purchases recommended : 0

Files modified : 0 (1 new report file only)

Packages installed : 0

External actions executed : 0 (0 emails sent, 0 CRM modifications, 0 forms submitted, 0 browser logins, 0 purchases, 0 social posts, 0 API keys added)

Verdict : **BUILD_THIN_DOCTEUR_AGENT**

Puis STOP.

NE PAS COMMENCER L'INTÉGRATION D'UN AGENT AUTOMATIQUEMENT. ATTENDRE VALIDATION UTILISATEUR.
