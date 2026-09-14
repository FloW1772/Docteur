import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Regression test for a real, measured bug: GET /api/router/providers took
// ~8-10s in production because the claude-oauth and codex checks (each
// shelling out to the real CLI — isCliInstalled() + testKey(), ~3s and ~5s
// respectively) ran sequentially in a `for...await` loop, even though the
// two providers are fully independent of each other. Fixed by switching to
// Promise.all(oauthProviders.map(...)). A true black-box timing test would
// need to spawn real CLIs (which test-mode intentionally blocks — see
// EXTERNAL_CALL_BLOCKED_IN_TEST in claude-oauth.js/codex.js), so this
// verifies the actual mechanism instead: the route source must build
// oauthProviderResults via Promise.all over a map, never a sequential
// for-loop with a push() per iteration.
test('router.js checks claude-oauth and codex in parallel, not sequentially', () => {
  const source = fs.readFileSync(new URL('./src/routes/router.js', import.meta.url), 'utf8');

  const oauthBlockStart = source.indexOf('const oauthProviderResults');
  assert.ok(oauthBlockStart !== -1, 'oauthProviderResults block not found');
  const oauthBlockEnd = source.indexOf('}));', oauthBlockStart) + 4;
  const oauthBlock = source.slice(oauthBlockStart, oauthBlockEnd);

  assert.ok(
    oauthBlock.includes('await Promise.all(oauthProviders.map('),
    'oauthProviderResults must be built with Promise.all(...map(...)), not a sequential for-loop — a regression here reintroduces the ~8-10s /router/providers latency (claude-oauth ~3s + codex ~5s CLI spawns, one after another)',
  );
  assert.ok(
    !/for\s*\(\s*const\s+id\s+of\s+oauthProviders\s*\)/.test(oauthBlock),
    'must not use a sequential for...of loop over oauthProviders',
  );
});
