# DOCTEUR — KIWIX POC / OFFLINE KNOWLEDGE, PHASE 1

Date: 2026-09-21/22
Scope: Windows direct-libzim binding POC only, per mission KX-1 ("Aucun code produit avant ce POC"). No product code, no API routes, no Settings UI, no data model was created — this phase never advanced past the packaging validation step, per KX-2's explicit instruction.

---

## Windows packaging POC — result: FAILED

### Candidate evaluated
`@openzim/libzim` (npm, v4.6.0) — the official, actively-maintained Node.js binding to libzim, previously identified in the Kiwix ecosystem audit (Phase 3) as the canonical binding to try. Confirmed: `node-libzim`/`@openzim/libzim` at github.com/openzim/node-libzim, GPLv3 license (the npm package itself; the underlying `libzim` C++ library is GPLv2-or-later, per its own README — this is a small correction to the Phase 3 audit's note that both were the same license family: they are compatible but not identical, `@openzim/libzim`'s own wrapper code is GPLv3 while it links against GPLv2-or-later libzim).

### Environment
- Node.js: v22.22.3 (satisfies the package's declared `engines.node: ">=22 <27"`)
- OS: Windows 11 Home 10.0.26200, x86_64
- Visual Studio: 2022 Community (17.14.37301.10) — confirmed present, with VC++ toolset v143 and Windows SDK 10.0.26100.0 correctly detected by node-gyp
- Python: 3.14.5 (satisfies node-gyp's build requirement)

### What was attempted
A real `npm install @openzim/libzim` in an isolated scratchpad directory (outside the Docteur repository, no `package.json`/`node_modules` changes made to the actual project at any point). This is exactly what mission KX-1 requires: an actual validated attempt, not a literature-only conclusion.

### What happened
1. npm correctly resolved and downloaded the `@openzim/libzim` package metadata.
2. The package's install step triggered `node-gyp rebuild` (the package has **no prebuilt Windows binary** — confirmed both by its own README: *"On GNU/Linux & macOS, the package will download a `libzim` binary. On other OSes you will need to install `libzim` separately"* — and by direct observation: the install immediately fell through to native compilation rather than fetching anything).
3. node-gyp correctly found MSVC (Visual Studio 2022, VC++ v143, Windows SDK 10.0.26100.0) and generated a valid `.vcxproj`/`.sln`.
4. MSBuild ran and **failed** with:
   ```
   error C1083: Impossible d'ouvrir le fichier include : 'zim/archive.h' : No such file or directory
   [...node_modules\@openzim\libzim\src\archive.h(4,10)...]
   ```

### Exact root cause
The Node addon's own C++ source (`src/archive.h`) correctly tries to `#include <zim/archive.h>` — but that header belongs to the **separate, underlying `libzim` C++ library**, which `@openzim/libzim`'s install step never fetches or builds on Windows. It is only auto-downloaded on Linux/macOS. On Windows, the README's own instruction is to "install libzim separately" with a bare link to libzim's own repository, no further guidance.

### Was there an official Windows path to unblock this?
Checked exhaustively, per KX-3's dependency-security instruction (verify canonical repo/license/current version/maintenance/Windows support before considering any binding):
- **libzim's official binary release server** (`download.openzim.org/release/libzim/`) was checked directly: it hosts Android (ARM/ARM64/x86/x86_64) and Linux (x86_64/aarch64/armhf/armv6/armv8, multiple libc flavors: standard/bionic/manylinux/musl) builds only. **Zero Windows builds exist at the official distribution point**, confirmed by absence of any `.zip`/`.dll`/`.lib`/`win`-named file.
- **libzim's own README** Windows guidance is limited to a caveat about not compiling in debug mode against release binaries that "are not" debug builds — implying Windows users are expected to build libzim itself from source via Meson (libzim's build system), which Docteur's toolchain does not currently use anywhere.
- **vcpkg** has a community-contributed `libzim` port (confirmed via a Microsoft/vcpkg PR), which is a real, legitimate path in principle — but it requires the user to already have vcpkg installed, build libzim from source through it, then manually point `node-gyp`/`@openzim/libzim`'s build at that install location via a `--libzim` argument (documented in the npm package's own instructions for using an external libzim). This is precisely the "obscure native compilation" scenario mission KX-1/KX-2 explicitly instruct not to force.

### KX-2 decision
Per the mission's explicit instruction: *"NE PAS substituer automatiquement : kiwix-serve, Docker, WSL, autre serveur HTTP. Ne pas forcer compilation native obscure. Produire : PARTIAL + cause exacte + option future. Puis STOP PHASE 1."*

This POC is a demonstrated, real, reproducible failure with an exact, fully-diagnosed root cause (missing native `libzim` C++ headers/library on Windows, no official prebuilt binary, no zero-friction install path). Per the mission's own decision tree, **no substitution was attempted** (no kiwix-serve fallback, no Docker, no WSL, no forced Meson/vcpkg build-from-source chain) — this report stops here, exactly as instructed.

---

## Security review (performed despite the POC failure, since the architecture/threat model was already fully designed and is worth recording for the future option below)

No code was written, so no live security testing occurred. The security design from Phase 3's audit (loopback-only, path-traversal-hardened ZIM reads, HTML sanitization before any rendering, prompt-injection-as-data discipline, provenance tagging) remains valid and unimplemented — it applies unchanged to whichever future packaging path is eventually chosen.

---

## Future option (documented, not started)

Per KX-2, one option is noted for a possible future, separately-scoped mission:
- **vcpkg-based build**: install vcpkg, build libzim through its `libzim` port, then build `@openzim/libzim`'s native addon against that install via its documented `--libzim` node-gyp argument. This is a real, working path in principle, but adds a heavyweight new build-toolchain dependency (vcpkg) to Docteur's Windows development environment that doesn't exist today, with real risk of its own maintenance burden (vcpkg port version lag, MSVC toolset compatibility drift between libzim releases and VS versions). Not attempted in this phase, per the explicit "ne pas forcer" instruction — would need its own dedicated feasibility mission if ever pursued, not folded into this one.
- No other viable Windows-native direct-ZIM-read path was identified in this research pass (no pure-JS ZIM reader with real Xapian full-text search support was found to exist — a pure-JS ZIM *parser* without search would only satisfy KX-7 discovery/metadata, not KX-8 search, and was not evaluated further since it would only be a partial solution).

---

## DOCTEUR KIWIX IMPLEMENTATION CHECKPOINT

Windows direct-libzim POC : **FAIL**

Binding/package : `@openzim/libzim` v4.6.0 (npm) — GPLv3 wrapper over libzim (GPLv2-or-later); actively maintained (CI badge, recent Node 26 support added), canonical `openzim/node-libzim` GitHub repo confirmed. Install fails on Windows: no prebuilt binary, and the underlying `libzim` C++ library has zero official Windows binary distribution — native compile fails with `C1083` (missing `zim/archive.h`), root cause fully diagnosed.

Library-root security : N/A (not implemented — no code was written past the packaging POC)

Local ZIM discovery : N/A (not implemented)

Search : N/A (not implemented)

Article extraction : N/A (not implemented)

HTML sanitization : N/A (not implemented)

Prompt injection treated as data : N/A (not implemented)

Provenance : N/A (not implemented)

RAG adapter : N/A (not implemented)

Strict Local : N/A (not implemented — no network capability was ever created to test against, consistent with the "0 attendu" expectations below since nothing was built)

External network calls : **0** (matches expectation)

Automatic downloads : **0** (matches expectation)

kiwix-serve processes : **0** (matches expectation — never used, per KX-2)

Raw HTML rendering : **0** (matches expectation — nothing was rendered, since nothing was built)

Tests : 0/0 (no tests were written — nothing to test, since the phase stopped at the packaging POC per KX-2's explicit instruction)

Typecheck : PASS (unaffected — zero source files were added or modified in the actual Docteur repository; the POC ran entirely in an isolated scratchpad directory outside the project and was removed afterward)

Build : PASS (unaffected, same reasoning)

Files changed : **0** in the Docteur repository (the POC's `npm install` ran in a temporary scratchpad directory outside `C:\dev\Docteur`, which was deleted after the POC concluded; only this report file and the KIWIX_POC report were added under `reports/`)

Known limitations : No Windows-native, low-friction path to direct libzim reads exists today via the standard npm ecosystem. The only real Windows path (vcpkg-based source build of libzim, then linking `@openzim/libzim`'s native addon against it) is a heavyweight, unattempted future option requiring a new build-toolchain dependency (vcpkg) that isn't part of Docteur's environment today, and was explicitly not forced per mission instruction. `kiwix-serve` (the alternative architecture Phase 3's audit considered and deprioritized in favor of direct ZIM reads) was not reconsidered or substituted in, per KX-2's explicit prohibition on automatic substitution — if Kiwix support is still desired, evaluating `kiwix-serve` (with its own already-documented `0.0.0.0`-default-bind risk from the Phase 3 audit) as a dedicated future mission is the more likely next step, not a continuation of the direct-libzim approach attempted here.

Verdict : **PARTIAL**

---

**PHASE 1 TERMINÉE.
Attente de validation utilisateur avant PHASE 2.**

NE PAS TOUCHER CODE INTELLIGENCE.
