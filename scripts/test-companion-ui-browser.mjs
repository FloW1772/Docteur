// [Companion V1] COMP-6A — browser suite: the REAL isolated Companion components in Chromium, answered in-process by
// the REAL COMP-5 framework + human approval channel + UI service on TEMPORARY stores (NB-5 on a temporary Docteur DB).
// Fixture overrides cover states the real backend cannot produce on demand (conflict, unknown statuses, model states,
// secret-shaped text). External requests are aborted and counted. No product route, no App.tsx / client.ts / server.js.
// Usage: node scripts/test-companion-ui-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite, getDatabase } from '../cortex-server/src/lib/sqlite.js';
import { ensureMemorySchema } from '../cortex-server/src/lib/notebook-memory-schema.js';
import { createNotebookDocumentService } from '../cortex-server/src/lib/notebook-documents.js';
import { createMemoryService } from '../cortex-server/src/lib/notebook-memory.js';
import { CompanionStore } from '../cortex-server/src/lib/companion-store.js';
import { CompanionMemory } from '../cortex-server/src/lib/companion-memory.js';
import { createCompanionActions } from '../cortex-server/src/lib/companion-actions.js';
import { createCompanionUiService } from '../cortex-server/src/lib/companion-ui-service.js';

let assertions = 0; const results = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const realDbBefore = REAL_DB.map(sha);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp6a-browser-'));
let fetchCalls = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error('no network from the Node side'); };

// ── backend (real) ──
initSqlite(path.join(TMP, 'docteur-temp.sqlite')); ensureMemorySchema(getDatabase());
const embed = async (t) => { const v = new Array(32).fill(0); for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 32] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const vecStore = () => { const rows = new Map(); return { rows, upsert: async (l) => { for (const r of l) rows.set(r.memory_id, r); }, search: async () => [], delete: async (ids) => { for (const i of ids) rows.delete(i); } }; };
createNotebookDocumentService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vecStore(), lancedbPath: path.join(TMP, 'x.lance'), localComplete: async () => 'ok' });
const rw = () => Array.from(crypto.randomBytes(6), b => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
let offset = 0; let nStore = 0; const stores = [];
function backend({ approvalTtlMs, failingVectors = false } = {}) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `c${++nStore}.sqlite`), now: () => Date.now() + offset }); stores.push(store);
  const vec = vecStore();
  const svc = createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vec, localComplete: async () => 'ok' });
  const mem = new CompanionMemory({ store, nb5: svc, vectorProbe: async (id) => (failingVectors ? true : vec.rows.has(id)), vectorPurge: async (id) => { if (failingVectors) throw new Error('vector store down'); vec.rows.delete(id); } });
  const actions = createCompanionActions({ store, companion: mem, ...(approvalTtlMs ? { approvalTtlMs } : {}) });
  const service = createCompanionUiService({ actions, companion: mem, store });
  return { store, mem, svc, actions, service, overrides: {}, log: [] };
}
const remember = (mem, opts = {}) => mem.rememberExplicit({ category: 'USER_PREFERENCE', value: `Je préfère ${rw()} ${rw()} ${rw()} ${rw()} ${rw()} pour mes notes.`, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' }, ...opts });
let current = null;

// ── browser plumbing ──
const PORT = 5271;
const page404 = '<div id="root"></div>';
const htmlFor = (cfg) => `<div id="root"></div><script>window.__companionHarness=${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/companion-ui-harness.jsx");mount();</script>`;
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-comp6a', plugins: [react()], optimizeDeps: { entries: ['scripts/companion-ui-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { external: [], errors: [] };
const responses = []; // every RPC value returned to the page (to prove the page never renders nonce / session / approval ids)

async function openPage(cfg = {}, { viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/__companion/rpc', async r => {
    const { method, args } = JSON.parse(r.request().postData() ?? '{}');
    current.log.push({ method, args });
    try {
      const fn = current.overrides[method] ?? current.service[method];
      if (typeof fn !== 'function') throw Object.assign(new Error('unknown method'), { code: 'UNKNOWN_ACTION' });
      const value = await fn(...(args ?? []));
      responses.push({ method, value });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value }) });
    } catch (e) {
      return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: e?.code ?? 'ACTION_FAILED', reason: e?.details?.reason ?? null, message: e?.message ?? 'refused' }) });
    }
  });
  await ctx.route('**/__companion', r => r.fulfill({ contentType: 'text/html', body: htmlFor(cfg) }));
  await ctx.route('**/__nothing', r => r.fulfill({ contentType: 'text/html', body: page404 }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__companion`);
  await page.getByTestId('cmp-panel').waitFor({ timeout: 60_000 });
  await page.getByTestId('cmp-status').getByText('État du Companion').waitFor();
  return { ctx, page };
}
const review = (page) => page.getByRole('dialog');
const stateOf = async (page) => (await page.getByTestId('cmp-review').getAttribute('data-ui-state'));
async function waitState(page, s, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await stateOf(page).catch(() => null) === s) return true; await sleep(50); } return false; }
const card = (page, memoryId) => page.locator(`article[data-memory-id="${memoryId}"]`);
const lastApproval = () => [...responses].reverse().find(r => r.method === 'submitIntent')?.value ?? null;
async function scenario(name, fn) {
  const before = assertions;
  try { await fn(); results.push({ name, ok: true, n: assertions - before }); console.log(`ok - ${name} (${assertions - before})`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`not ok - ${name}\n  ${e.message.split('\n').join('\n  ')}`); }
}

try {
  // ── 1. memory panel, provenance, privacy, stale; why-do-you-know-this; context used ──
  await scenario('memory panel + why-do-you-know-this + context used (real backend)', async () => {
    current = backend();
    const a = await remember(current.mem);
    const hs = await remember(current.mem, { category: 'USER_FACT', value: `Mon dossier ${rw()} ${rw()} est suivi par le Dr ${rw()}.`, sensitivity: 'HIGHLY_SENSITIVE' });
    offset = -3 * 86_400_000; const stale = await remember(current.mem, { reviewAfterDays: 1 }); offset = 0;
    current.mem.recordContextAssembly({ requestId: 'req-ui-1', memoryIds: [a.memoryId], itemIds: ['request:req-ui-1', `memory:${a.memoryId}`], typeCounts: { MEMORY: 1, USER_REQUEST: 1 }, privacyCounts: { PRIVATE_LOCAL: 2 } });
    const { ctx, page } = await openPage({ contextRequestId: 'req-ui-1' });
    await card(page, a.memoryId).waitFor();
    eq(await page.locator('article[data-memory-id]').count(), 3, 'three memory cards');
    ok((await card(page, a.memoryId).innerText()).includes('Je préfère'), 'summary rendered');
    ok((await card(page, a.memoryId).innerText()).includes('Dit par vous'), 'provenance rendered');
    ok((await card(page, a.memoryId).innerText()).includes('PRIVATE_LOCAL'), 'privacy rendered');
    const ncBadge = card(page, hs.memoryId).locator('[data-scope="NEVER_CLOUD"]');
    ok((await ncBadge.innerText()).includes('jamais envoyé au cloud'), 'NEVER_CLOUD is explicit');
    ok((await ncBadge.getAttribute('aria-label')).includes('ne quitte jamais'), 'NEVER_CLOUD aria label');
    ok((await card(page, stale.memoryId).innerText()).includes('À REVOIR'), 'stale memory flagged');
    ok(!(await card(page, a.memoryId).innerText()).includes('À REVOIR'), 'fresh memory not flagged');
    await card(page, a.memoryId).getByRole('button', { name: /Pourquoi tu sais ça/ }).click();
    const why = page.getByTestId('cmp-why');
    await why.waitFor();
    eq(await page.evaluate(() => document.activeElement?.id), 'cmp-why-title', 'focus moves to the explanation');
    const whyText = await why.innerText();
    for (const s of [a.memoryId, 'Dit par vous', 'USER_INPUT', 'Oui', 'PRIVATE_LOCAL']) ok(whyText.includes(s), `why shows ${s}`);
    await why.getByRole('button', { name: 'Fermer l’explication' }).click();
    await page.getByRole('button', { name: /Quels souvenirs ont servi/ }).click();
    const ctxWhy = page.getByTestId('cmp-why-context');
    await ctxWhy.waitFor();
    const t = await ctxWhy.innerText();
    ok(t.includes('req-ui-1') && t.includes(`memory:${a.memoryId}`) && t.includes('MEMORY'), 'context used listed');
    const html = await page.content();
    ok(!/system prompt|BEGIN_CONTEXT_DATA|nonce/i.test(html), 'no system prompt / context markers / nonce in the page');
    await ctx.close();
  });

  // ── 2. simple confirmation, full flow, pointer gesture ──
  await scenario('SIMPLE_CONFIRM full flow: proposal → preview → trusted click → intent → COMP-5 approval → execution', async () => {
    current = backend();
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    const dlg = review(page);
    await dlg.waitFor();
    eq(await dlg.getAttribute('aria-modal'), 'true', 'dialog semantics');
    ok((await dlg.getAttribute('aria-labelledby')).startsWith('cmp-review-'), 'dialog labelled');
    ok(await page.evaluate(() => document.activeElement?.tagName === 'H2' && document.activeElement.closest('[role=dialog]') !== null), 'focus inside the dialog');
    eq(await stateOf(page), 'PENDING', 'PENDING');
    const rows = await page.getByTestId('cmp-preview').locator('tr').evaluateAll(trs => trs.map(t => t.getAttribute('data-row')));
    for (const k of ['action', 'target', 'riskClass', 'summary', 'changes', 'effects', 'reversible', 'privacyImpact', 'pointOfNoReturn', 'confirmation', 'expiresAt', 'digest', 'parameters']) ok(rows.includes(k), `preview row ${k}`);
    const proposal = [...responses].reverse().find(r => r.method === 'propose').value;
    await page.getByTestId('cmp-digest').waitFor();
    eq(await page.getByTestId('cmp-digest').innerText(), proposal.digest.slice(0, 12), 'the confirmed digest is the proposal digest');
    eq(await page.getByTestId('cmp-preview').locator('tr[data-row="digest"] td').innerText(), proposal.digest.slice(0, 12), 'preview shows the same digest');
    eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'SIMPLE_CONFIRM');
    ok(await page.getByTestId('cmp-btn-confirm').isEnabled(), 'simple confirm enabled once the challenge exists');
    ok(current.mem.view(a.memoryId).companion.companionEnabled, 'nothing changed before the gesture');
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'APPROVED');
    ok(Number(await page.getByTestId('cmp-approval-left').innerText()) > 100, 'approval countdown');
    const approved = current.actions.audit.list().find(e => e.event === 'ACTION_APPROVED');
    eq(approved.details.channel, 'UI_GESTURE', 'approval came through the UI gesture channel');
    eq(approved.details.gesture, 'POINTER', 'pointer gesture');
    ok(current.mem.view(a.memoryId).companion.companionEnabled, 'approval alone changes nothing');
    await page.getByTestId('cmp-btn-execute').click();
    ok(await waitState(page, 'EXECUTED'), 'EXECUTED');
    eq(await page.getByTestId('cmp-result').getAttribute('data-success'), 'true');
    eq(current.mem.view(a.memoryId).companion.companionEnabled, false, 'executed on the backend');
    const html = await page.content();
    const ap = lastApproval();
    const ch = [...responses].reverse().find(r => r.method === 'issueChallenge').value;
    ok(!html.includes(ch.nonce) && !html.includes(ch.uiSessionId) && !html.includes(ap.approvalId), 'nonce / UI session id / approval id never rendered');
    await page.getByTestId('cmp-btn-close').click();
    await dlg.waitFor({ state: 'detached' });
    await ctx.close();
  });

  // ── 3. no gesture: a script-dispatched click is not trusted ──
  await scenario('no gesture / fake: a synthetic click (isTrusted=false) never approves; a forced fake intent is refused by the server', async () => {
    current = backend();
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    await page.evaluate(() => document.querySelector('[data-testid="cmp-btn-confirm"]').click()); // untrusted
    await page.getByRole('alert').filter({ hasText: 'APPROVAL_REQUIRED' }).waitFor();
    eq(await stateOf(page), 'PENDING', 'still PENDING');
    eq(current.store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0, 'no approval from a synthetic click');
    eq(current.log.filter(l => l.method === 'submitIntent').length, 0, 'no intent even sent');
    // a page script forging an intent with humanConfirmed is refused by the server
    const forged = await page.evaluate(async () => {
      const r = await fetch('/__companion/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'submitIntent', args: [{ humanConfirmed: true }] }) });
      return (await r.json()).code;
    });
    eq(forged, 'APPROVAL_INTENT_INVALID', 'humanConfirmed boolean refused');
    eq(current.store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0);
    await ctx.close();
  });

  // ── 4. keyboard + focus trap + Escape ──
  await scenario('keyboard: Tab stays in the dialog, Enter on Confirmer approves (KEYBOARD gesture), Escape closes and focus returns', async () => {
    current = backend();
    const a = await remember(current.mem); const b = await remember(current.mem);
    const { ctx, page } = await openPage();
    const opener = card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ });
    await opener.focus(); await page.keyboard.press('Enter');
    await review(page).waitFor(); await page.getByTestId('cmp-digest').waitFor();
    for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]'))), `focus trapped (${i})`); }
    await page.getByTestId('cmp-btn-confirm').focus(); await page.keyboard.press('Enter');
    ok(await waitState(page, 'APPROVED'), 'approved by keyboard');
    eq(current.actions.audit.list().find(e => e.event === 'ACTION_APPROVED').details.gesture, 'KEYBOARD', 'KEYBOARD gesture recorded');
    await page.keyboard.press('Escape');
    await review(page).waitFor({ state: 'detached' });
    eq(await page.evaluate(() => document.activeElement?.textContent ?? ''), await opener.textContent(), 'focus returns to the opener');
    // keyboard only: open a forget review and type the phrase
    const fb = card(page, b.memoryId).getByRole('button', { name: /Oublier/ });
    await fb.focus(); await page.keyboard.press('Enter');
    await page.getByTestId('cmp-typed').waitFor();
    ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'typed confirm disabled while empty');
    await page.getByLabel('Phrase de confirmation').focus();
    await page.keyboard.type(`FORGET ${b.memoryId}`);
    ok(await page.getByTestId('cmp-btn-confirm').isEnabled(), 'enabled with the exact phrase');
    await page.keyboard.press('Escape');
    await review(page).waitFor({ state: 'detached' });
    ok(current.svc.getMemory(b.memoryId), 'Escape forgets nothing');
    await ctx.close();
  });

  // ── 5. typed confirmation: forget COMPLETE; wrong phrase; forced button ──
  await scenario('TYPED_CONFIRM forget: warnings, wrong phrase disabled, a page script bypassing the UI is refused by the server, exact phrase → COMPLETE', async () => {
    current = backend();
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Oublier/ }).click();
    const w = page.getByTestId('cmp-forget-warning');
    await w.waitFor();
    const wt = await w.innerText();
    for (const s of [a.memoryId, 'Irréversible', 'FORGET_INCOMPLETE', 'Docteur Memory', 'Index vectoriel', 'Métadonnées Companion', 'Références de session']) ok(wt.includes(s), `forget warning: ${s}`);
    eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'TYPED_CONFIRM');
    eq(await page.getByTestId('cmp-phrase').innerText(), `FORGET ${a.memoryId}`);
    for (const wrong of ['forget', `forget ${a.memoryId}`, `FORGET ${a.memoryId} `]) { await page.getByTestId('cmp-typed').fill(wrong); ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), `disabled for "${wrong}"`); }
    // bypassing the UI entirely: a page script submits an intent with the live challenge but the wrong phrase
    const ch = [...responses].reverse().find(r => r.method === 'issueChallenge').value;
    const bypass = await page.evaluate(async (c) => {
      const intent = { proposalId: c.proposalId, actionDigest: c.actionDigest, confirmationKind: c.confirmationKind, uiSessionId: c.uiSessionId, nonce: c.nonce, createdAt: new Date().toISOString(), gesture: { kind: 'POINTER', trusted: true }, typedPhrase: 'FORGET x' };
      const r = await fetch('/__companion/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'submitIntent', args: [intent] }) });
      return (await r.json()).code;
    }, ch);
    eq(bypass, 'CONFIRMATION_REQUIRED', 'the server refuses the wrong phrase: a disabled button is not the protection');
    eq(current.store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0, 'no approval');
    ok(current.svc.getMemory(a.memoryId), 'nothing forgotten');
    await page.getByTestId('cmp-typed').fill(`FORGET ${a.memoryId}`);
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    await page.getByTestId('cmp-btn-execute').click();
    ok(await waitState(page, 'EXECUTED'), 'executed');
    ok((await page.getByTestId('cmp-result').innerText()).includes('FULL'), 'effect FULL');
    eq(current.svc.getMemory(a.memoryId), null, 'forgotten in NB-5');
    await ctx.close();
  });

  // ── 6. FORGET_INCOMPLETE ──
  await scenario('FORGET_INCOMPLETE is never shown as success', async () => {
    current = backend({ failingVectors: true });
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Oublier/ }).click();
    await page.getByTestId('cmp-typed').fill(`FORGET ${a.memoryId}`);
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    await page.getByTestId('cmp-btn-execute').click();
    ok(await waitState(page, 'INCOMPLETE'), 'INCOMPLETE state');
    const r = page.getByTestId('cmp-result');
    eq(await r.getAttribute('data-success'), 'false', 'not a success');
    eq(await r.getAttribute('data-result-state'), 'INCOMPLETE');
    ok((await r.getAttribute('class')).includes('warn') && !(await r.getAttribute('class')).includes(' ok'), 'warning tone, never ok');
    const t = await r.innerText();
    ok(t.includes('pas un succès') && t.includes('NB5_VECTOR'), 'remaining store listed');
    ok(!/Exécutée\b/.test(t), 'no "Exécutée" title');
    eq(await page.getByTestId('cmp-btn-execute').count(), 0, 'no execute (no automatic retry)');
    await ctx.close();
  });

  // ── 7. reinforced confirmation: NEVER_CLOUD release ──
  await scenario('REINFORCED_CONFIRM NEVER_CLOUD release: current / new scope, consequence, every acknowledgement + exact phrase', async () => {
    current = backend();
    const hs = await remember(current.mem, { category: 'USER_FACT', value: `Allergie ${rw()} ${rw()} notée par ${rw()}.`, sensitivity: 'HIGHLY_SENSITIVE' });
    const { ctx, page } = await openPage();
    const c = card(page, hs.memoryId);
    ok(await c.getByRole('button', { name: /Proposer ce changement/ }).isDisabled(), 'no proposal without a change (not a toggle)');
    await c.getByLabel(/Nouvelle portée/).selectOption('PRIVATE_LOCAL');
    ok((await c.innerText()).includes('confirmation renforcée'), 'loosening announced before proposing');
    await c.getByRole('button', { name: /Proposer ce changement/ }).click();
    const w = page.getByTestId('cmp-release-warning');
    await w.waitFor();
    eq(await w.locator('[data-scope]').nth(0).getAttribute('data-scope'), 'NEVER_CLOUD', 'current scope');
    eq(await w.locator('[data-scope]').nth(1).getAttribute('data-scope'), 'PRIVATE_LOCAL', 'new scope');
    ok((await w.innerText()).includes('envoi cloud pourra devenir possible'), 'future cloud consequence');
    eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'REINFORCED_CONFIRM');
    const phrase = `RELEASE NEVER_CLOUD ${hs.memoryId}`;
    await page.getByTestId('cmp-typed').fill(phrase);
    ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'phrase alone is not enough');
    const boxes = page.getByTestId('cmp-confirm').getByRole('checkbox');
    eq(await boxes.count(), 2, 'two acknowledgements');
    await boxes.nth(0).check();
    ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'one acknowledgement is not enough');
    await boxes.nth(1).check();
    ok(await page.getByTestId('cmp-btn-confirm').isEnabled(), 'every acknowledgement + phrase');
    await page.getByTestId('cmp-typed').fill('RELEASE NEVER_CLOUD');
    ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'acknowledgements alone are not enough');
    await page.getByTestId('cmp-typed').fill(phrase);
    eq(current.mem.view(hs.memoryId).privacyScope, 'NEVER_CLOUD', 'still locked');
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    eq(current.actions.audit.list().find(e => e.event === 'ACTION_APPROVED').details.confirmationKind, 'REINFORCED_CONFIRM');
    await page.getByTestId('cmp-btn-execute').click();
    ok(await waitState(page, 'EXECUTED'), 'executed');
    eq(current.mem.view(hs.memoryId).privacyScope, 'PRIVATE_LOCAL', 'released on the backend');
    await ctx.close();
  });

  // ── 8. approval expiry ──
  await scenario('approval expiry: Execute disabled, new confirmation needed', async () => {
    current = backend({ approvalTtlMs: 5_000 });
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    ok(await waitState(page, 'EXPIRED', 9_000), 'EXPIRED after the approval TTL');
    ok(await page.getByTestId('cmp-btn-execute').isDisabled(), 'Execute disabled');
    await page.getByTestId('cmp-expired').waitFor();
    await page.getByTestId('cmp-btn-reconfirm').click();
    ok(await waitState(page, 'PENDING'), 'a new proposal to confirm');
    await page.getByTestId('cmp-digest').waitFor();
    ok(current.mem.view(a.memoryId).companion.companionEnabled, 'nothing executed');
    await ctx.close();
  });

  // ── 9. preview stale + approval already used ──
  await scenario('PREVIEW_STALE and APPROVAL_ALREADY_USED: refused, shown, no execution offered', async () => {
    current = backend();
    const a = await remember(current.mem); const b = await remember(current.mem);
    const { ctx, page } = await openPage();
    await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    current.mem.setCompanionEnabled(a.memoryId, false); // the state changes after the person saw the preview
    await page.getByTestId('cmp-btn-confirm').click();
    await page.locator('[role=alert][data-error-code="PREVIEW_STALE"]').first().waitFor();
    eq(current.store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0, 'no approval on a stale preview');
    ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'cannot confirm again with a burnt challenge');
    await page.getByTestId('cmp-btn-close').click();
    await card(page, b.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    const ap = lastApproval();
    const p = current.actions.user.getProposal(ap.proposalId);
    const r = await current.service.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId, executionId: 'consumed-elsewhere' });
    eq(r.status, 'EXECUTED', 'the approval was used elsewhere first');
    await page.getByTestId('cmp-btn-execute').click();
    await page.getByRole('alert').filter({ hasText: 'APPROVAL_ALREADY_USED' }).waitFor();
    ok(await page.getByTestId('cmp-btn-execute').isDisabled().catch(() => true), 'Execute no longer offered');
    eq(current.actions.audit.list().filter(e => e.event === 'APPROVAL_CONSUMED' && e.proposalId === ap.proposalId).length, 1, 'consumed once');
    await ctx.close();
  });

  // ── 10. model proposal labelling ──
  await scenario('model proposal: PROPOSED_BY_MODEL, never APPROVED_BY_MODEL; still needs the person’s gesture', async () => {
    current = backend();
    const a = await remember(current.mem);
    const out = current.actions.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: a.memoryId, enabled: false } });
    const dto = await current.service.getProposal(out.proposalId);
    const { ctx, page } = await openPage({ pendingProposals: [dto] });
    const item = page.getByTestId('cmp-pending').locator(`[data-proposal-id="${out.proposalId}"]`);
    ok((await item.innerText()).includes('PROPOSED_BY_MODEL'), 'labelled in the list');
    await item.getByRole('button', { name: /Examiner/ }).click();
    await page.getByTestId('cmp-model-note').waitFor();
    eq(await page.getByTestId('cmp-proposed-by').getAttribute('data-proposed-by'), 'MODEL');
    ok(!/APPROVED_BY_MODEL|approuvé par le modèle/i.test(await page.content()), 'never approved by the model');
    eq(await stateOf(page), 'PENDING', 'waits for the person');
    eq(current.store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0);
    await page.getByTestId('cmp-digest').waitFor();
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved only after the click');
    eq(current.actions.audit.list().find(e => e.event === 'ACTION_APPROVED').details.channel, 'UI_GESTURE');
    await ctx.close();
  });

  // ── 11. memory OFF ──
  await scenario('global memory OFF via the UI: durable / session / proposals / context OFF, forget available', async () => {
    current = backend();
    const a = await remember(current.mem);
    const { ctx, page } = await openPage();
    ok(!(await page.getByTestId('cmp-memory-off').count()), 'memory ON at first');
    await page.locator('button[data-pref="memoryEnabled"]').click();
    await page.getByTestId('cmp-digest').waitFor();
    ok((await page.getByTestId('cmp-preview').innerText()).includes('memoryEnabled : true → false'), 'preview shows the change');
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    await page.getByTestId('cmp-btn-execute').click();
    ok(await waitState(page, 'EXECUTED'), 'executed');
    await page.getByTestId('cmp-btn-close').click();
    await page.getByTestId('cmp-memory-off').waitFor();
    for (const k of ['durableRetrieval', 'sessionMemory', 'proposals', 'contextMemory']) eq(await page.locator(`[data-contract="${k}"]`).innerText(), 'OFF', `${k} OFF`);
    eq(await page.locator('[data-contract="forget"]').innerText(), 'Disponible', 'forget available');
    ok(await card(page, a.memoryId).getByRole('button', { name: /Oublier/ }).isEnabled(), 'forget button still available');
    eq(current.mem.preferences().memoryEnabled, false);
    await ctx.close();
  });

  // ── 12. fixtures: conflict, unknown statuses, model states, secrets, error codes ──
  await scenario('fixtures: conflict, unknown statuses fail-closed, model status from metadata only, secrets never rendered, error states', async () => {
    current = backend();
    const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX12345678';
    const row = (extra) => ({ memoryId: `mem-${crypto.randomUUID()}`, category: 'USER_PREFERENCE', state: 'ACTIVE', conflict: false, privacyScope: 'PRIVATE_LOCAL', companionEnabled: true, sensitivity: 'NORMAL', summary: 'Résumé normal', summaryWithheld: null, reviewRequired: false, freshness: { confirmedAt: '2026-10-16T10:00:00.000Z' }, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT', proposalId: null, evidenceCount: 0 }, ...extra });
    const rows = [row({ state: 'DISPUTED', conflict: true }), row({ privacyScope: 'PUBLIC_INTERNET', state: 'SOMETHING' }), row({ summary: `Ma clé est ${SECRET}` }), row({ summary: null, summaryWithheld: 'SECRET_SHAPE' })];
    current.overrides.listMemories = async () => rows;
    current.overrides.explainMemory = async (id) => ({ memoryId: id, state: 'DISPUTED', conflict: 'OPEN_CONFLICT', durableOwner: 'NB5', nb5Status: 'APPROVED', sensitivity: 'NORMAL', privacyScope: 'PRIVATE_LOCAL', companionEnabled: true, category: 'USER_PREFERENCE', freshness: {}, provenance: { origin: 'DERIVED', sourceType: 'MODEL', proposalId: null, sessionId: null, evidenceRefs: [{ kind: 'NOTEBOOK_CHUNK', ref: `Authorization: Bearer ${'z'.repeat(30)}` }], sourceReference: null, derivedBy: null } });
    current.overrides.getStatus = async () => ({ activation: 'DISABLED_PENDING_CERTIFICATION', schemaVersion: 3, preferences: { memoryEnabled: true, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: false }, model: { status: 'TIMEOUT', code: 'MODEL_TIMEOUT', at: null, source: 'COMPANION_MODEL_AUDIT' } });
    const weird = { ...(await current.service.propose('COMPANION.PREFERENCES.UPDATE', { proposalEnabled: false })), status: 'APPROVED_BY_MODEL' };
    let ctx; let page;
    ({ ctx, page } = await openPage({ pendingProposals: [weird] }));
    await page.locator('article[data-memory-id]').first().waitFor();
    ok((await card(page, rows[0].memoryId).innerText()).includes('CONFLIT'), 'conflict badge');
    ok((await card(page, rows[1].memoryId).innerText()).includes('PORTÉE INCONNUE'), 'unknown privacy fail-closed');
    ok((await card(page, rows[1].memoryId).innerText()).includes('État inconnu'), 'unknown memory state');
    ok(!(await page.content()).includes(SECRET), 'secret never rendered');
    ok((await card(page, rows[2].memoryId).innerText()).includes('[masqué]'), 'secret masked');
    ok((await card(page, rows[3].memoryId).innerText()).includes('Résumé masqué'), 'withheld summary explained');
    eq(await page.getByTestId('cmp-model-status').getAttribute('data-model-status'), 'TIMEOUT', 'model TIMEOUT from metadata');
    await card(page, rows[0].memoryId).getByRole('button', { name: /Pourquoi tu sais ça/ }).click();
    await page.getByTestId('cmp-why').waitFor();
    const whyT = await page.getByTestId('cmp-why').innerText();
    ok(whyT.includes('CONFLIT OUVERT') && whyT.includes('Déduit (non confirmé)') && whyT.includes('Non'), 'conflict + unconfirmed derivation');
    ok(!(await page.content()).includes('z'.repeat(30)), 'bearer token never rendered');
    // unknown proposal status: nothing enabled
    await page.getByTestId('cmp-pending').getByRole('button', { name: /Examiner/ }).click();
    ok(await waitState(page, 'UNKNOWN'), 'unknown status → UNKNOWN');
    await page.getByTestId('cmp-unknown').waitFor();
    for (const id of ['cmp-btn-confirm', 'cmp-btn-execute', 'cmp-btn-cancel', 'cmp-btn-reconfirm']) eq(await page.getByTestId(id).count(), 0, `${id} absent`);
    eq(current.log.filter(l => l.method === 'issueChallenge').length, 0, 'no challenge for an unknown state');
    await ctx.close();
    // model states: default real backend = NOT_RUN (no probe), LOCAL_UNAVAILABLE, unknown
    for (const [status, expected] of [[null, 'NOT_RUN'], ['LOCAL_UNAVAILABLE', 'LOCAL_UNAVAILABLE'], ['READY', 'UNKNOWN']]) {
      current = backend();
      if (status) current.overrides.getStatus = async () => ({ ...(await current.service.getStatus()), model: { status, code: null, at: null, source: 'COMPANION_MODEL_AUDIT' } });
      ({ ctx, page } = await openPage());
      await page.getByTestId('cmp-model-status').waitFor();
      eq(await page.getByTestId('cmp-model-status').getAttribute('data-model-status'), expected, `model ${expected}`);
      if (expected === 'UNKNOWN') ok((await page.getByTestId('cmp-model-status').innerText()).includes('non affirmé'), 'unknown model never claimed available');
      await ctx.close();
    }
    // error codes rendered as refusals
    current = backend();
    const a = await remember(current.mem);
    ({ ctx, page } = await openPage());
    for (const c of ['APPROVAL_REQUIRED', 'APPROVAL_EXPIRED', 'LOCAL_MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_CANCELLED', 'ACTION_FAILED', 'SOMETHING_NEW']) {
      current.overrides.propose = async () => { throw Object.assign(new Error(c), { code: c }); };
      await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
      const al = page.locator(`[role=alert][data-error-code="${c}"]`);
      await al.waitFor();
      ok((await al.innerText()).length > c.length + 3, `${c} rendered with a text`);
      if (c === 'SOMETHING_NEW') ok((await al.innerText()).includes('raison inconnue'), 'unknown code = refusal');
    }
    await ctx.close();
  });

  // ── 13. responsive + cancel ──
  await scenario('narrow viewport + cancel / reject: no horizontal overflow; cancel and reject end the proposal', async () => {
    current = backend();
    const a = await remember(current.mem); const b = await remember(current.mem);
    const { ctx, page } = await openPage({}, { viewport: { width: 390, height: 800 } });
    await card(page, a.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll');
    await page.getByRole('button', { name: 'Refuser' }).click();
    ok(await waitState(page, 'REJECTED'), 'REJECTED');
    await page.getByTestId('cmp-btn-close').click();
    await card(page, b.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
    await page.getByTestId('cmp-digest').waitFor();
    await page.getByTestId('cmp-btn-confirm').click();
    ok(await waitState(page, 'APPROVED'), 'approved');
    await page.getByTestId('cmp-btn-cancel').click();
    ok(await waitState(page, 'CANCELLED'), 'CANCELLED before execution');
    ok(current.mem.view(b.memoryId).companion.companionEnabled, 'nothing executed');
    await ctx.close();
  });

  eq(net.external.length, 0, `no external request (${net.external.join(', ')})`);
  eq(net.errors.length, 0, `no page error (${net.errors.join(' | ')})`);
  eq(fetchCalls, 0, 'no network from the Node side');
  eq(JSON.stringify(REAL_DB.map(sha)), JSON.stringify(realDbBefore), 'user database untouched');
} finally {
  await browser.close();
  await server.close();
  globalThis.fetch = realFetch;
  for (const s of stores) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}
const failed = results.filter(r => !r.ok);
console.log(`${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} scenarios, ${assertions} assertions`);
process.exit(failed.length ? 1 : 0);
