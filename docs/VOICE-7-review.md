# VOICE-7 review before modification

2026-09-20: `git status --short`, `git diff --stat`, VOICE-6 audit and implementation reviewed. The worktree contains uncommitted VOICE-2–6 work and external projects; preserve them. VOICE-6 docs and browser harnesses are intentional validation assets, not production dependencies.

The application coordinator remains the global state owner. Capture generations, atomic confirmation refs, TTS identity checks, aborts and owner cleanup stay unchanged. Existing devicechange/voiceschanged effects remove their listeners. No STT/TTS/VAD/registry/policy/lifecycle rewrite is needed.

UX gaps: settings save only updates the modal, mobile hides the main status, cloud selection ignores the Strict Local UI state, confirmation lacks focus restoration, read-aloud controls remain visible for policy-rejected text, and microphone diagnostics publish React state every animation frame. Diagnostics can keep processing each frame while publishing at 10 Hz.

Implementation scope: a dedicated voice settings section (mounted only on the voice tab), runtime metadata passed from App without transcripts/credentials, registry-derived discovery filtered to supported intents, accessible confirmation and command controls, scoped responsive styles, and real-component browser tests. STT language is currently fixed to French; show it as fixed rather than introducing an unsupported preference. Preserve existing optional wake-word configuration separately and disclose its actual status; do not claim that a configured wake listener is an inactive microphone.
