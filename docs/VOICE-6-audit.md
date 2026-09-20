# VOICE-6 — audit before implementation

Baseline inspected on 2026-09-20; existing VOICE-2–5 working-tree changes are preserved.

| Owner | Existing states / transitions | Risks found |
| --- | --- | --- |
| useVoiceActivation | idle / wake-listening → recording → transcribing → pending → idle | stop of recording transcribes even on explicit cancel; pending permission and AudioContext.resume race; mode/action callback read after capture; unmount does not abort STT; old recorder callbacks share chunks |
| STT | IDLE → QUEUED → TRANSCRIBING → COMPLETED / COMPLETED_EMPTY / CANCELLED / ERROR | generation checks cover result but not finally; cancelled operation can clear next controller; already-aborted signal not checked |
| VoiceOutput | IDLE → QUEUED → SPEAKING → COMPLETED / CANCELLED / ERROR | stale onstart/end/error can change new utterance; no exception cleanup; mic exclusion is only a start callback |
| Command pipeline | mode + feedback + pending confirmation | no session binding; STOP while confirmation pending does not clear it reliably; no mounted guard |
| Confirmation | pending → confirmed / cancelled / expired on interaction | execution inside React state updater; stale closure double confirm; no expiry timer |
| Cortex / CommandBar | derived legacy capture state + separate TTS badge | transcribing, thinking and speaking can contradict each other; no shared application vocabulary |

## Decisions

One application lifecycle coordinator, shared by existing hooks, owns the global UI state and capture generation. Technical STT/VAD/TTS states remain internal diagnostics. Explicit transitions reject stale/incoherent updates. A new capture binds mode and action context through its start-time command callback. Cancellation invalidates the generation before cleaning resources.

Manual microphone activation cancels TTS synchronously before requesting a stream. Conversely TTS revokes capture and pending transcription before speaking. No simultaneous capture/TTS is permitted; this exclusion does not depend on echoCancellation. Wake callbacks must also obey the exclusion.

Automatic VAD barge-in: NOT IMPLEMENTED. The energy-based VAD has no source identity or acoustic reference signal. Browser echo cancellation is not proof that synthetic speech cannot trigger commands. Mock waveforms cannot establish reliable speaker attribution. No new always-listening capture or preference is introduced.

Timers: capture owns RAF and 30-second recording cap; STT owns its 90-second deadline; pipeline owns its 20-second confirmation deadline; TTS owns a bounded playback watchdog. Cancel, replacement and unmount clear their owner's timers and detach callbacks. STOP never cancels a non-voice system job.

No new intents, privileged handlers, cloud routing, audio retention or transcript logging. Ollama-assisted Intent and Local Explainer remain NOT IMPLEMENTED.

## Implemented ownership and integration

- `VoiceLifecycle` is instantiated once in App and passed to capture, intent and TTS hooks. Standalone harnesses may instantiate isolated coordinators. `getSnapshot` is the only application voice state consumed by CommandBar and Cortex; legacy hook states remain technical compatibility outputs.
- Capture binds its command callback (mode, actions and target context), STT provider and generation before requesting microphone permission. Manual STOP discards audio; only natural VAD/recording deadline completion transcribes. Transcript review remains available, except deterministic STOP which cancels immediately on STT completion. Spoken STOP requires a transcript; the Stop button cancels immediately in every phase.
- The synchronous deterministic parser has no timer or asynchronous model request. Transcript tokens reject duplicate dispatch and old-session delivery. Confirmation stores the exact intent and start-time action bindings in a ref, consumes it before executing, checks `now >= expiresAt`, and owns one deadline. Execution never occurs inside a React setter.
- TTS cancels capture and confirmations before playing. Utterance identity guards start/end/error, detachment precedes browser cancellation, and a 120-second watchdog handles missing browser completion events. Cancelled playback never resumes automatically.
- Console response requests capture a generation guard. STOP, a new recording, replacement speech, console close/navigation or unmount suppress an old response's automatic read-aloud. The underlying non-voice request is not cancelled. A new explicit manual read remains possible.
- Capture owns recorder callbacks, tracks, AudioContext, RAF and max duration; STT owns AbortController and deadline; pipeline owns confirmation deadline; output owns utterance callbacks and watchdog. Keyboard listeners are removed on cleanup. Existing `devicechange` and `voiceschanged` subscriptions have paired removal; devicechange and keyboard remount behavior are exercised in browser tests.
- Known microphone errors use fixed user-facing messages; unknown microphone, STT, TTS and action exceptions never display raw exception text. Retrying capture or playback starts a fresh generation. Confirmation UI retains both buttons and shows action, non-sensitive feature target and expiry.

## Validation scope

Browser tests use the real React hooks in StrictMode with deterministic MediaRecorder, stream, STT and speechSynthesis mocks. They deliberately return aborted STT requests late and replay detached callbacks. The self-listening fixture injects simulated TTS samples into a formerly active recorder and attempts OPEN_FEATURE, SEARCH_QUERY, CONFIRM and STOP while speech is active: zero actions. This validates software exclusion, not physical speaker identification. No acoustic/hardware certification or automatic VAD barge-in is claimed.

Count convention: existing voice assertions are 32 response/TTS + 53 intent = 85. Browser interaction assertions are 9 existing mode tests + 74 VOICE-6 tests = 83. Audio metrics/VAD, basic lifecycle and microphone diagnostics are additional passing suites, not invented assertion counts. CommandBar and Strict-local are reported separately (13 and 6).

VOICE-4.1 response regression is included in the 32 response/TTS assertions. Typecheck uses `npx tsc --noEmit`; production build uses `npm run build`. The existing large-bundle warning is non-blocking. No VOICE-7 work was started.
