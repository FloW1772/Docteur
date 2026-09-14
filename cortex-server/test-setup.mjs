// Shared test-mode guard. Import this FIRST (before any provider module) in
// every test-*.mjs file. It sets DOCTEUR_TEST_MODE=1, which the Codex and
// Claude Code CLI providers check before spawning their subprocess — see
// EXTERNAL_CALL_BLOCKED_IN_TEST in providers/codex.js and providers/claude-oauth.js.
//
// Regression guard for: test-ai-provider-fallback.mjs previously triggered a
// real Codex subscription API call because the generic fallback-chain tests
// never mocked claudeOAuthProvider/codexProvider, and router.js's
// cloudCandidates() calls the real isConfigured()/generate() on any
// unmocked provider when the CLI is actually authenticated on the machine.
process.env.DOCTEUR_TEST_MODE = '1';
