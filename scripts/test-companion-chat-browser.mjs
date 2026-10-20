// [COMP-9 CHAT] Companion chat in Chromium: the real panel + real HTTP port, /api/companion/* stubbed in-test (no real
// backend, model, Notebook or KG). Scenarios:
//    1 empty state            2 send → reply           3 loading state           4 cancel aborts the request
//    5 failure                6 retry → success        7 late answer blocked     8 memory OFF / ON (+ "why" provenance)
//    9 graph provenance       10 safe text rendering   11 narrow viewport        12 keyboard (Enter / Shift+Enter / Tab)
//   13 no external request    + unmount aborts, ignored model action, Companion not active
// Usage: node scripts/test-companion-chat-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const PORT = 5279;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const API = 'http://127.0.0.1:3001/api/companion';

const HARNESS_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/companion-chat-harness.jsx");mount();</script></body></html>';
const harnessPage = { name: 'comp9-harness-page', configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url === '/__chat') { res.setHeader('content-type', 'text/html'); res.end(HARNESS_HTML); } else next(); }); } };
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-comp9', plugins: [react(), harnessPage], optimizeDeps: { entries: ['scripts/companion-chat-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
let externalAborted = 0;

const answerDto = (extra = {}) => ({
  requestId: `cans_${Math.random().toString(16).slice(2, 14)}`, text: 'Bonjour, je suis le Companion.', truncated: false, local: true, model: 'llama3.2:3b', durationMs: 4200, contextItems: 2, actionProposalIgnored: false,
  diagnostics: { kgContextUsed: false, kg: { gate: 'KG_OPEN', state: 'ACTIVE', status: 'COMP_7_NO_MATCH', authority: 'NONE', retrieved: 0, used: 0, dropped: 0, chars: 0, excluded: [] } },
  kgProvenance: [], ...extra,
});

/**
 * A fresh page whose Companion API is stubbed. `answers(n, body)` decides the n-th POST /answers:
 * { value } | { status, code } | 'hold' (pending until released; `held[i]()` fulfills it with { value } if still possible).
 */
async function openPage({ answers = () => ({ value: answerDto() }), memoryEnabled = false, activation = 'ACTIVE', viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const log = { answers: [], aborted: 0, explain: [], held: [] };
  page.on('requestfailed', (r) => { if (r.url() === `${API}/answers`) log.aborted += 1; });
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify(body) }).catch(() => {});
  await page.route(() => true, async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.origin === ORIGIN) return route.continue();
    if (!u.href.startsWith(API)) { externalAborted += 1; return route.abort(); }
    const p = u.pathname.replace('/api/companion', '');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET,POST,DELETE', 'access-control-allow-headers': 'content-type' } });
    if (p === '/status') return json(route, 200, { ok: true, value: { activation, schemaVersion: 4, preferences: { memoryEnabled, sessionMemoryEnabled: false, proposalEnabled: true, cloudContextEnabled: false }, model: { status: 'NOT_RUN', code: null, at: null, source: 'COMPANION_MODEL_AUDIT' } } });
    if (p === '/memories' || p === '/proposals') return json(route, 200, { ok: true, value: [] });
    if (p === '/sessions' && req.method() === 'POST') return json(route, 200, { ok: true, value: { uiSessionId: 's'.repeat(32) } });
    if (p.startsWith('/sessions/') && req.method() === 'DELETE') return json(route, 200, { ok: true, value: true });
    const ex = /^\/contexts\/([^/]+)\/explanation$/.exec(p);
    if (ex) { log.explain.push(decodeURIComponent(ex[1])); return json(route, 200, { ok: true, value: { requestId: decodeURIComponent(ex[1]), found: true, usedAt: '2026-10-20T20:00:00.000Z', contextUsed: [{ itemId: 'mem-1', kind: 'DURABLE_MEMORY' }], memories: [], truncationCount: 0 } }); }
    if (p === '/answers' && req.method() === 'POST') {
      log.answers.push(req.postData());
      const a = answers(log.answers.length);
      if (a === 'hold') { await new Promise((release) => log.held.push(release)); return json(route, 200, { ok: true, value: answerDto({ text: 'RÉPONSE TARDIVE' }) }); }
      if (a.value) return json(route, 200, { ok: true, value: a.value });
      return json(route, a.status, { ok: false, error: { code: a.code, message: 'refusé', reason: null } });
    }
    return json(route, 404, { ok: false, error: { code: 'COMP_NOT_FOUND', message: 'introuvable', reason: null } });
  });
  await page.goto(`${ORIGIN}/__chat`);
  await page.getByTestId('cmp-chat').waitFor();
  return { page, context, log, errors };
}
const input = (page) => page.getByTestId('cmp-chat-input');
async function ask(page, text) { await input(page).fill(text); await page.getByTestId('cmp-chat-send').click(); }
const waitUntil = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); } catch (e) { console.error(`✖ ${name}`); throw e; }
  results.push(`✔ ${name} (${Date.now() - t} ms)`);
}

try {
  await scenario('1. empty chat: explanatory empty state, memory state stated, Send disabled until there is text', async () => {
    const { page, context, errors } = await openPage();
    await page.getByTestId('cmp-chat-empty').waitFor();
    ok((await page.getByTestId('cmp-chat-empty').innerText()).includes('modèle local, sans cloud'));
    ok((await page.getByTestId('cmp-chat-empty').innerText()).includes('n’est pas envoyé au modèle'), 'statelessness stated honestly');
    eq(await page.getByTestId('cmp-chat-mem-state').getAttribute('data-memory'), 'OFF');
    ok(await page.getByTestId('cmp-chat-send').isDisabled(), 'nothing to send');
    eq(errors.length, 0, errors.join(' | '));
    await context.close();
  });

  await scenario('2. send → reply: the user turn, then the backend text with factual metadata; body is { text } only', async () => {
    const { page, context, log } = await openPage();
    await ask(page, 'Bonjour, qui es-tu ?');
    await page.getByTestId('cmp-chat-answer').waitFor();
    eq(await page.getByTestId('cmp-chat-user').locator('.cmp-chat-text').innerText(), 'Bonjour, qui es-tu ?', 'the user turn shows exactly what was sent');
    ok((await page.getByTestId('cmp-chat-answer').innerText()).includes('Bonjour, je suis le Companion.'));
    eq(await page.getByTestId('cmp-chat-meta').innerText(), 'modèle local llama3.2:3b · 4,2 s · 2 éléments de contexte');
    eq(log.answers.length, 1);
    eq(log.answers[0], JSON.stringify({ text: 'Bonjour, qui es-tu ?' }), 'strict request body');
    eq(await input(page).inputValue(), '', 'input cleared after sending');
    await context.close();
  });

  await scenario('3 + 4. loading state, then Annuler aborts the HTTP request and returns to a stable state', async () => {
    const { page, context, log } = await openPage({ answers: () => 'hold' });
    await ask(page, 'Raconte une longue histoire');
    await page.getByTestId('cmp-chat-pending').waitFor();
    ok(await page.getByTestId('cmp-chat-pending').getByRole('status').isVisible(), 'pending announced as a status');
    ok(await page.getByTestId('cmp-chat-send').isDisabled(), 'one generation at a time');
    await page.getByTestId('cmp-chat-cancel').click();
    ok(await waitUntil(() => log.aborted === 1), 'the request was really aborted (not just hidden)');
    await page.getByTestId('cmp-chat-cancelled').waitFor();
    eq(await page.getByTestId('cmp-chat-pending').count(), 0, 'no orphan spinner');
    for (const release of log.held) release();
    await page.waitForTimeout(150);
    eq(await page.getByTestId('cmp-chat-answer').count(), 0, 'the late server answer is not shown');
    await input(page).fill('Autre question');
    ok(await page.getByTestId('cmp-chat-send').isEnabled(), 'can send again');
    await context.close();
  });

  await scenario('5 + 6. failure shows the coded French error; Retry re-sends the same question and succeeds', async () => {
    const { page, context, log } = await openPage({ answers: (n) => (n === 1 ? { status: 503, code: 'LOCAL_MODEL_UNAVAILABLE' } : { value: answerDto({ text: 'Réponse après reprise.' }) }) });
    await ask(page, 'Quelle heure est-il ?');
    await page.getByTestId('cmp-chat-error').waitFor();
    eq(await page.getByTestId('cmp-chat-error').getAttribute('data-code'), 'LOCAL_MODEL_UNAVAILABLE');
    ok((await page.getByRole('alert').filter({ hasText: 'Aucun modèle local disponible.' }).count()) === 1);
    await page.getByTestId('cmp-chat-retry').click();
    await page.getByTestId('cmp-chat-answer').waitFor();
    ok((await page.getByTestId('cmp-chat-answer').innerText()).includes('Réponse après reprise.'));
    eq(log.answers[1], JSON.stringify({ text: 'Quelle heure est-il ?' }), 'Retry re-sends the same question');
    eq(await page.getByTestId('cmp-chat-user').count(), 1, 'the question is not duplicated');
    eq(await page.getByTestId('cmp-chat-error').count(), 0, 'the failed turn was replaced');
    await context.close();
  });

  await scenario('5b. network failure is reported as "injoignable", not as a model error', async () => {
    const { page, context } = await openPage();
    await page.route(`${API}/answers`, (route) => route.abort('connectionrefused'));
    await ask(page, 'Bonjour');
    await page.getByTestId('cmp-chat-error').waitFor();
    eq(await page.getByTestId('cmp-chat-error').getAttribute('data-code'), 'NETWORK');
    ok((await page.getByTestId('cmp-chat-error').innerText()).includes('injoignable'));
    await context.close();
  });

  await scenario('7. late answer blocked: a cancelled request released after a newer answer never replaces it', async () => {
    const { page, context, log } = await openPage({ answers: (n) => (n === 1 ? 'hold' : { value: answerDto({ text: 'Réponse à la seconde question.' }) }) });
    await ask(page, 'Première question');
    await page.getByTestId('cmp-chat-pending').waitFor();
    await page.getByTestId('cmp-chat-cancel').click();
    await ask(page, 'Seconde question');
    await page.getByTestId('cmp-chat-answer').waitFor();
    for (const release of log.held) release();
    await page.waitForTimeout(200);
    eq(await page.getByTestId('cmp-chat-answer').count(), 1);
    ok((await page.getByTestId('cmp-chat-answer').innerText()).includes('Réponse à la seconde question.'));
    ok(!(await page.locator('body').innerText()).includes('RÉPONSE TARDIVE'));
    await context.close();
  });

  await scenario('8. memory OFF: stated, no "why" button; memory ON: "why" shows the context the backend recorded for that answer', async () => {
    const off = await openPage({ memoryEnabled: false });
    await ask(off.page, 'Bonjour');
    await off.page.getByTestId('cmp-chat-answer').waitFor();
    ok((await off.page.getByTestId('cmp-chat-mem-state').innerText()).includes('aucun souvenir n’est lu ni enregistré'));
    eq(await off.page.getByTestId('cmp-chat-why').count(), 0, 'no context record exists when memory is off');
    await off.context.close();
    const on = await openPage({ memoryEnabled: true, answers: () => ({ value: answerDto({ requestId: 'cans_abc123' }) }) });
    eq(await on.page.getByTestId('cmp-chat-mem-state').getAttribute('data-memory'), 'ON');
    await ask(on.page, 'Que sais-tu de moi ?');
    await on.page.getByTestId('cmp-chat-why').click();
    await on.page.getByText('Contexte utilisé — requête cans_abc123').waitFor();
    eq(on.log.explain[0], 'cans_abc123', 'the explanation is for exactly this answer');
    await on.context.close();
  });

  await scenario('9. graph provenance: sources listed from the response only; ignored model action is stated', async () => {
    const { page, context } = await openPage({ answers: () => ({ value: answerDto({
      actionProposalIgnored: true,
      diagnostics: { kgContextUsed: true, kg: { gate: 'KG_OPEN', state: 'ACTIVE', status: 'COMP_7_OK', authority: 'NONE', retrieved: 3, used: 2, dropped: 0, chars: 300, excluded: [] } },
      kgProvenance: [
        { itemId: 'kg:e1', sourceRef: 'neuron:v-1', evidenceRefs: [{ kind: 'KG_SOURCE', ref: 'neuron:v-1' }], authority: 'NONE' },
        { itemId: 'kg:e2', sourceRef: 'neuron:pl-soupes', evidenceRefs: [], authority: 'NONE' },
      ],
    }) }) });
    await ask(page, 'Parle-moi de la bouillabaisse');
    await page.getByTestId('cmp-chat-answer').waitFor();
    ok((await page.getByTestId('cmp-chat-meta').innerText()).endsWith('2 sources du graphe'));
    await page.getByTestId('cmp-chat-sources').locator('summary').click();
    const sources = await page.getByTestId('cmp-chat-sources').innerText();
    ok(sources.includes('Sources du graphe de connaissances (2)') && sources.includes('neuron:v-1 — 1 preuve') && sources.includes('neuron:pl-soupes'), sources);
    ok((await page.getByTestId('cmp-chat-action-ignored').innerText()).includes('n’a pas été enregistrée'));
    await context.close();
  });

  await scenario('10. safe rendering: HTML / script / Markdown / javascript: links in model text stay inert text', async () => {
    const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> **gras** [lien](javascript:window.__xss=3) <a href="javascript:window.__xss=4">clic</a>';
    const { page, context } = await openPage({ answers: () => ({ value: answerDto({ text: hostile }) }) });
    await ask(page, 'test');
    await page.getByTestId('cmp-chat-answer').waitFor();
    await page.waitForTimeout(200);
    const answer = page.getByTestId('cmp-chat-answer');
    eq(await answer.locator('img, script, a, strong, b').count(), 0, 'no element created from model text');
    ok((await answer.locator('.cmp-chat-text').innerText()).includes('<img src=x onerror="window.__xss=1">'), 'shown literally');
    eq(await page.evaluate(() => window.__xss), undefined, 'nothing executed');
    await context.close();
  });

  await scenario('11. narrow viewport (360 px): no horizontal overflow, input and Send reachable', async () => {
    const { page, context } = await openPage({ viewport: { width: 360, height: 780 }, answers: () => ({ value: answerDto({ text: 'x'.repeat(600) }) }) });
    await ask(page, 'Une réponse très longue sans espace');
    await page.getByTestId('cmp-chat-answer').waitFor();
    eq(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no horizontal scroll');
    const box = await page.getByTestId('cmp-chat-send').boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= 360, 'Send inside the viewport');
    await page.getByTestId('cmp-chat').screenshot({ path: '.tmp/companion-chat-360.png' });
    await context.close();
  });

  await scenario('12. keyboard: Enter sends, Shift+Enter adds a line, Send and Retry are focusable buttons', async () => {
    const { page, context, log } = await openPage({ answers: (n) => (n === 1 ? { status: 504, code: 'MODEL_TIMEOUT' } : { value: answerDto() }) });
    await input(page).focus();
    await page.keyboard.type('Ligne 1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Ligne 2');
    eq(await input(page).inputValue(), 'Ligne 1\nLigne 2', 'Shift+Enter = new line');
    eq(log.answers.length, 0, 'nothing sent yet');
    await page.keyboard.press('Enter');
    await page.getByTestId('cmp-chat-error').waitFor();
    eq(log.answers[0], JSON.stringify({ text: 'Ligne 1\nLigne 2' }), 'Enter = send');
    eq(await page.evaluate(() => document.activeElement?.id), 'cmp-chat-input', 'focus stays in the input after sending');
    await page.getByTestId('cmp-chat-retry').focus();
    eq(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'cmp-chat-retry', 'Retry is focusable');
    await page.keyboard.press('Enter');
    await page.getByTestId('cmp-chat-answer').waitFor();
    eq(log.answers.length, 2, 'Retry activated from the keyboard');
    await page.getByTestId('cmp-chat').screenshot({ path: '.tmp/companion-chat-desktop.png' });
    await context.close();
  });

  await scenario('unmount during a generation aborts the request (no orphan request)', async () => {
    const { page, context, log } = await openPage({ answers: () => 'hold' });
    await ask(page, 'Question longue');
    await page.getByTestId('cmp-chat-pending').waitFor();
    await page.evaluate(() => window.__unmount());
    ok(await waitUntil(() => log.aborted === 1), 'request aborted on unmount');
    await context.close();
  });

  await scenario('Companion not active: the chat says so and offers no input', async () => {
    const { page, context, log } = await openPage({ activation: 'DISABLED_PENDING_CERTIFICATION' });
    await page.getByTestId('cmp-chat-unavailable').waitFor();
    eq(await page.getByTestId('cmp-chat-input').count(), 0);
    eq(log.answers.length, 0);
    await context.close();
  });

  await scenario('13. loopback only: no request left the page except the local Companion API', async () => {
    eq(externalAborted, 0, 'no external request');
  });
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(r);
console.log(`COMPANION CHAT BROWSER: ${results.length} scenarios, ${assertions} assertions — PASS`);
