VOICE-7 CHECKPOINT — UX & SETTINGS

Voice Settings : PASS
Microphone settings : PASS
STT visibility : PASS
TTS settings : PASS
Voice Privacy panel : PASS
DICTATION / COMMAND visibility : PASS
Command discovery : PASS
Registry-driven command list : PASS
Unified voice status UX : PASS
Confirmation UX : PASS
STOP accessibility : PASS
TTS controls : PASS
Error UX : PASS
Unknown command UX : PASS
Responsive : PASS
Keyboard : PASS
Focus management : PASS
Screen-reader labels : PASS
Reduced motion : PASS

Diagnostic mode : PASS
Diagnostic UI throttling : PASS
Microphone test remains local : PASS
Settings live propagation : PASS
Strict Local cloud gating : PASS

Automatic VAD barge-in : NOT IMPLEMENTED
Always listening : NOT IMPLEMENTED

Unexpected cloud audio : 0
Voice policy bypass : 0
Raw shell : 0
Secrets exposed : 0

VOICE-2 regression : PASS
VOICE-3 regression : PASS
VOICE-4 regression : PASS
VOICE-5 regression : PASS
VOICE-6 regression : PASS

Strict-local : 6/6
Voice tests : 85/85
Browser tests : 191/191
CommandBar : 13/13

Typecheck : PASS
Build : PASS

Files changed : 9 tracked (modified) + 24 untracked (new)
Diff summary (tracked files only) : +637 / -207
Diff summary (session total incl. new files, as reported by prior session) : ~+3465 / -2888

Known limitations :
- STT language is fixed to French, shown as fixed rather than a real selector (by design, per VOICE-7 review).
- Automatic VAD barge-in and always-listening remain unimplemented; manual barge-in (explicit stop/interrupt) is the supported interaction.
- Chunk-size build warnings are pre-existing (index/esm bundles >500kB) and unrelated to VOICE-7; no new warnings introduced.

Notes on totals vs VOICE-6 baseline:
- "Voice tests: 85/85" reproduces the VOICE-6 baseline exactly (test-voice-intent.mjs 53/53 + test-voice-response-tts.mjs 32/32); unchanged by VOICE-7.
- "Strict-local: 6/6" reproduces the VOICE-6 baseline exactly via cortex-server/test-strict-local-centralized.mjs (route-level gating for research/teacher/voice), unchanged by VOICE-7.
- "Browser tests" grew from the VOICE-6 baseline of 83/83 to 191/191 because VOICE-7 added two new browser suites that did not exist at VOICE-6 time: test-voice-ux-browser.mjs (86/86, new VOICE-7 settings/status/gating UX) and confirms test-voice-interruption-browser.mjs (74/74, VOICE-6 carryover), plus test-command-bar-browser.mjs (13/13) and test-voice-intent-mode-browser.mjs (9/9), which were not committed at VOICE-6 checkpoint time either. The increase is additive test coverage for new VOICE-7 UI, not a change to old assertions — no prior browser assertion was removed or weakened.
- test-voice-audio.mjs, test-voice-lifecycle.mjs and test-voice-microphone-browser.mjs report descriptive PASS (no shared numeric counter in their harness) and are confirmed passing but not included in the numeric tallies above.

VOICE-7 : PASS
