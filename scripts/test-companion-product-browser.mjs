// COMP-6B — real App shell → typed HTTP port/route → real COMP-5 approval framework on temporary stores.
// No real user DB, model, Notebook, KG, Investigator, cloud, or external network is used.
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
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
import { createCompanionUiRoute } from '../cortex-server/src/routes/companion.js';
import { openCompanionAtBoot, resolveCompanionBoot } from '../cortex-server/src/lib/companion-boot.js';

const { serve } = await import(pathToFileURL(createRequire(path.resolve('cortex-server', 'package.json')).resolve('@hono/node-server')).href);
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };
const sha = (p) => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent';
const realDb = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const realBefore = realDb.map(sha);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp6b-product-'));
const vectorStore = () => { const rows = new Map(); return { rows, upsert: async (list) => { for (const row of list) rows.set(row.memory_id, row); }, search: async () => [], delete: async (ids) => { for (const id of ids) rows.delete(id); } }; };
const embed = async (text) => { const v = new Array(32).fill(0); for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % v.length] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const randomWords = () => crypto.randomBytes(18).toString('hex').match(/.{1,6}/g).join(' ');

// The Companion stays closed until a human activates it. Since certification (COMPANION-BOOT-PROD-REMED-1) a normal
// boot defers to the official production store, which lives in the REAL product data directory — so this test never
// opens it (its state is machine-dependent and it is real user data). The pure decision opens nothing; the activation
// gate itself is exercised on a throwaway store selected the way the product selects its development store.
const normalDecision = resolveCompanionBoot({ env: {} });
eq(normalDecision.enabled, false); eq(normalDecision.reason, 'COMPANION_NOT_REQUESTED', 'normal boot defers to the production store gate');
const gatedBoot = openCompanionAtBoot({ env: { DOCTEUR_COMPANION_DEV_DB: path.join(tmp, 'boot-gate', 'companion.sqlite') } });
eq(gatedBoot.store, null, 'no Companion store is opened without human activation');
eq(gatedBoot.decision.reason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
eq(gatedBoot.decision.activation.state, 'DISABLED_PENDING_HUMAN_ACTIVATION');
const disabledRoute = createCompanionUiRoute({ disabledReason: gatedBoot.decision.reason });
let response = await disabledRoute.request('http://localhost/companion/status');
eq(response.status, 200);
const disabledStatus = (await response.json()).value;
eq(disabledStatus.activation, 'DISABLED_PENDING_HUMAN_ACTIVATION'); eq(disabledStatus.disabledReason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
response = await disabledRoute.request('http://localhost/companion/sessions', { method: 'POST' });
eq(response.status, 503); eq((await response.json()).error.code, 'COMPANION_DISABLED');

// Explicit test-only data roots: NB-5 and Companion are both temporary.
initSqlite(path.join(tmp, 'docteur.sqlite')); ensureMemorySchema(getDatabase());
createNotebookDocumentService({ embedText: embed, embeddingModel: 'test', embedFormat: {}, vectorStore: vectorStore(), lancedbPath: path.join(tmp, 'notebook.lance'), localComplete: async () => { throw new Error('model must not run'); } });
const vectors = vectorStore();
const nb5 = createMemoryService({ embedText: embed, embeddingModel: 'test', embedFormat: {}, vectorStore: vectors, localComplete: async () => { throw new Error('model must not run'); } });
const store = CompanionStore.open({ dbPath: path.join(tmp, 'companion.sqlite') });
const memory = new CompanionMemory({ store, nb5, vectorProbe: async (id) => vectors.rows.has(id), vectorPurge: async (id) => { vectors.rows.delete(id); } });
const actions = createCompanionActions({ store, companion: memory, approvalTtlMs: 5_000 });
const service = createCompanionUiService({ actions, companion: memory, store });
const route = createCompanionUiRoute({ service });
const normal = await memory.rememberExplicit({ category: 'USER_PREFERENCE', value: `Préférence produit ${randomWords()}.`, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' } });
const forgetMe = await memory.rememberExplicit({ category: 'USER_FACT', value: `Souvenir à oublier ${randomWords()}.`, sensitivity: 'SENSITIVE', confirmSensitive: true, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' } });
const neverCloud = await memory.rememberExplicit({ category: 'USER_FACT', value: `Donnée sensible ${randomWords()}.`, sensitivity: 'HIGHLY_SENSITIVE', confirmSensitive: true, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' } });
eq(memory.view(neverCloud.memoryId).privacyScope, 'NEVER_CLOUD');

const apiEvents = []; const approvals = []; const proposals = [];
const apiServer = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url); apiEvents.push(`${request.method} ${url.pathname}`);
  const local = new Request(`http://localhost${url.pathname.replace(/^\/api/, '')}${url.search}`, request);
  const out = await route.fetch(local);
  if (out.headers.get('content-type')?.includes('json')) {
    const json = await out.clone().json().catch(() => null);
    if (url.pathname === '/api/companion/approvals' && json?.value) approvals.push(json.value);
    if (url.pathname === '/api/companion/proposals' && json?.value) proposals.push(json.value);
  }
  return out;
} });
await new Promise((resolve, reject) => { if (apiServer.listening) resolve(); else { apiServer.once('listening', resolve); apiServer.once('error', reject); } });
const apiPort = apiServer.address().port;

const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/companion-product-harness.jsx");mount();</script>';
const vite = await createServer({
  configFile: false, cacheDir: '.tmp/vite-comp6b-product', plugins: [react()],
  define: { 'import.meta.env.VITE_COMPANION_SAME_ORIGIN': JSON.stringify('true') },
  optimizeDeps: { entries: ['scripts/companion-product-harness.jsx'] },
  server: { watch: null, host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api/companion': { target: `http://127.0.0.1:${apiPort}` } } },
  logLevel: 'error',
});
await vite.listen();
const frontendPort = vite.httpServer.address().port;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => localStorage.setItem('docteur.showHomeScreen', 'false'));
const external = []; const pageErrors = [];
await context.route(url => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(url).hostname), r => { external.push(r.request().url()); return r.abort(); });
await context.route('**/__comp6b_product', r => r.fulfill({ contentType: 'text/html', body: html }));
const page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
const card = (id) => page.locator(`article[data-memory-id="${id}"]`);
const state = () => page.getByTestId('cmp-review').getAttribute('data-ui-state');
const waitState = async (wanted, timeout = 10_000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await state().catch(() => null) === wanted) return true; await page.waitForTimeout(50); } return false; };
const closeReview = async () => { await page.getByTestId('cmp-btn-close').click(); await page.getByTestId('cmp-review').waitFor({ state: 'detached' }); };
const approveExecute = async () => { await page.getByTestId('cmp-btn-confirm').click(); ok(await waitState('APPROVED'), 'approved'); await page.getByTestId('cmp-btn-execute').click(); ok(await waitState('EXECUTED'), 'executed'); };

try {
  await page.goto(`http://127.0.0.1:${frontendPort}/__comp6b_product`);
  await page.getByText('DOCTEUR', { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  eq(apiEvents.length, 0, 'Companion route untouched at app load');

  await page.keyboard.press('F1');
  const search = page.getByLabel('Rechercher une fonctionnalité'); await search.waitFor(); await search.fill('Companion');
  const row = page.locator('div').filter({ has: page.getByText('Companion', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Ouvrir' }) }).last();
  ok((await row.innerText()).includes('désactivé en attente de certification'), 'Help state is honest');
  await row.getByRole('button', { name: 'Ouvrir' }).click();
  await page.getByTestId('cmp-panel').waitFor(); await page.getByTestId('cmp-status').waitFor();
  ok((await page.getByTestId('cmp-status').innerText()).includes('DISABLED_PENDING_HUMAN_ACTIVATION'), 'activation state visible');
  eq(actions.audit.list().filter(e => e.event === 'ACTION_PROPOSED').length, 0, 'no automatic action proposal');
  eq(store.listModelAudit().length, 0, 'no automatic model call');
  await card(normal.memoryId).waitFor(); eq(await page.locator('article[data-memory-id]').count(), 3, 'temporary memories visible');

  await card(normal.memoryId).getByRole('button', { name: /Pourquoi tu sais ça/ }).click();
  const why = page.getByTestId('cmp-why'); await why.waitFor();
  const whyText = await why.innerText();
  for (const value of [normal.memoryId, 'Dit par vous', 'USER_INPUT', 'PRIVATE_LOCAL']) ok(whyText.includes(value), `why contains ${value}`);
  ok(!/system prompt|credential|nonce|approvalId/i.test(whyText), 'why renders no secret authority data');
  await why.getByRole('button', { name: /Fermer l’explication/ }).click();

  // SIMPLE_CONFIRM, fake gesture refusal, then the real trusted flow.
  await card(normal.memoryId).getByRole('button', { name: /Ne plus utiliser/ }).click();
  await page.getByTestId('cmp-digest').waitFor(); eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'SIMPLE_CONFIRM');
  await page.evaluate(() => document.querySelector('[data-testid="cmp-btn-confirm"]').click());
  await page.locator('[role=alert][data-error-code="APPROVAL_REQUIRED"]').waitFor(); eq(await state(), 'PENDING', 'synthetic click refused');
  const forged = await page.evaluate(async () => { const r = await fetch('/api/companion/approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ humanConfirmed: true }) }); return r.json(); });
  eq(forged.error.code, 'APPROVAL_INTENT_INVALID', 'humanConfirmed is not approval');
  await approveExecute(); eq(memory.view(normal.memoryId).companion.companionEnabled, false); const usedApproval = approvals.at(-1); const usedProposal = proposals.at(-1);
  const replay = await page.evaluate(async ({ approvalId, actionId, parameters }) => { const r = await fetch('/api/companion/executions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId, actionId, parameters, executionId: 'replay-product-0001' }) }); return r.json(); }, { approvalId: usedApproval.approvalId, actionId: usedProposal.actionId, parameters: usedProposal.parameters });
  eq(replay.error.code, 'APPROVAL_ALREADY_USED', 'approval replay refused'); await closeReview();

  // TYPED_CONFIRM forget.
  await card(forgetMe.memoryId).getByRole('button', { name: /Oublier/ }).click();
  await page.getByTestId('cmp-typed').waitFor(); eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'TYPED_CONFIRM');
  const forgetPhrase = await page.getByTestId('cmp-phrase').innerText(); await page.getByTestId('cmp-typed').fill(forgetPhrase);
  await approveExecute(); const forgotten = memory.view(forgetMe.memoryId); eq(forgotten.state, 'MISSING', 'forget removed the NB-5 record'); eq(forgotten.companion, null, 'forget removed Companion metadata'); eq(await page.getByTestId('cmp-result').getAttribute('data-success'), 'true'); await closeReview();

  // REINFORCED_CONFIRM to release NEVER_CLOUD: phrase alone is insufficient.
  const nc = card(neverCloud.memoryId); await nc.getByLabel(/Nouvelle portée/).selectOption('PRIVATE_LOCAL'); await nc.getByRole('button', { name: /Proposer ce changement/ }).click();
  await page.getByTestId('cmp-typed').waitFor(); eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'REINFORCED_CONFIRM');
  const releasePhrase = await page.getByTestId('cmp-phrase').innerText(); await page.getByTestId('cmp-typed').fill(releasePhrase); ok(await page.getByTestId('cmp-btn-confirm').isDisabled(), 'phrase alone cannot release NEVER_CLOUD');
  const boxes = page.getByTestId('cmp-confirm').getByRole('checkbox'); eq(await boxes.count(), 2); await boxes.nth(0).check(); await boxes.nth(1).check();
  await approveExecute(); eq(memory.view(neverCloud.memoryId).privacyScope, 'PRIVATE_LOCAL');

  // [COMP-REMED-1] Model proposals: model output reaches the typed route (as the model wiring would post it); the panel
  // lists it as PROPOSED_BY_MODEL; LOCAL_MUTATION goes through the same human gesture → approval → one execution.
  const postModel = async (rawOutput) => { const r = await route.request('http://localhost/companion/model-proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawOutput }) }); return { status: r.status, json: await r.json() }; };
  const selfApproved = await postModel(JSON.stringify({ text: 'ok', actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { sessionMemoryEnabled: false }, approved: true } }));
  eq(selfApproved.json.error?.code, 'ACTION_NOT_ALLOWED'); eq(selfApproved.json.error?.reason, 'MODEL_SELF_APPROVAL', 'model self-approval refused at the route');
  const loosen = await postModel(JSON.stringify({ actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } } }));
  eq(loosen.json.error?.reason, 'MODEL_PRIVACY_LOOSENING', 'model privacy loosening refused');
  // [COMP-REMED-2] CR-1: an ambiguous (duplicate-key) model output is refused at the route — string rawOutput, and a
  // duplicate key in the raw HTTP body itself (rawOutput sent as an object) — with 0 proposal / approval / mutation.
  const postRaw = async (text) => { const r = await route.request('http://localhost/companion/model-proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }); return { status: r.status, json: await r.json() }; };
  const openBeforeDup = actions.user.listProposals({ status: 'PENDING' }).length + actions.user.listProposals({ status: 'APPROVED' }).length;
  const proposedBeforeDup = actions.audit.list().filter(e => e.event === 'ACTION_PROPOSED').length; const approvalsBeforeDup = approvals.length; const prefsBeforeDup = JSON.stringify(store.getPreferences());
  const dupString = await postModel('{"text":"ok","actionProposal":{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"sessionMemoryEnabled":false}}}');
  eq(dupString.status, 400); eq(dupString.json.error?.code, 'INVALID_ACTION_PAYLOAD'); eq(dupString.json.error?.reason, 'MODEL_OUTPUT_DUPLICATE_KEY', 'duplicate actionId refused at the route');
  const dupBody = await postRaw('{"rawOutput":{"actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"sessionMemoryEnabled":true,"session\\u004demoryEnabled":false}}}}');
  eq(dupBody.json.error?.reason, 'MODEL_OUTPUT_DUPLICATE_KEY', 'escaped duplicate in the raw body refused (not last-wins through c.req.json)');
  ok(!JSON.stringify([dupString.json, dupBody.json]).includes('sessionMemoryEnabled'), 'refusal carries no model content');
  eq(actions.audit.list().filter(e => e.event === 'ACTION_PROPOSED').length, proposedBeforeDup, 'duplicate-key output: 0 proposal');
  eq(actions.user.listProposals({ status: 'PENDING' }).length + actions.user.listProposals({ status: 'APPROVED' }).length, openBeforeDup, 'duplicate-key output: 0 open proposal');
  eq(approvals.length, approvalsBeforeDup, 'duplicate-key output: 0 approval'); eq(JSON.stringify(store.getPreferences()), prefsBeforeDup, 'duplicate-key output: 0 mutation');
  const mu =(await postModel(JSON.stringify({ text: 'Je peux désactiver la mémoire de session.', actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { sessionMemoryEnabled: false } } }))).json.value;
  const ro = (await postModel(JSON.stringify({ text: 'Je peux lister vos souvenirs.', actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } }))).json.value;
  eq(mu.proposedBy, 'MODEL'); eq(ro.proposedBy, 'MODEL'); eq(mu.confirmationKind, 'SIMPLE_CONFIRM'); eq(ro.confirmationKind, 'NONE');
  await closeReview(); // the panel reloads what the backend holds
  const muRow = page.locator(`[data-proposal-id="${mu.proposalId}"]`); await muRow.waitFor();
  ok((await muRow.innerText()).includes('PROPOSED_BY_MODEL'), 'panel lists the model proposal as PROPOSED_BY_MODEL');
  ok((await page.locator(`[data-proposal-id="${ro.proposalId}"]`).innerText()).includes('PROPOSED_BY_MODEL'), 'READ_ONLY model proposal listed');
  eq(await page.locator('[data-proposal-id]').count(), openBeforeDup + 2, '[COMP-REMED-2] panel lists only the two valid model proposals (none from the refused outputs)');
  const noApproval = await page.evaluate(async ({ actionId, parameters, proposalId }) => { const r = await fetch('/api/companion/executions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, parameters, proposalId, executionId: 'direct-model-exec-0001' }) }); return r.json(); }, { actionId: mu.actionId, parameters: { sessionMemoryEnabled: false }, proposalId: mu.proposalId });
  ok(noApproval.error?.code, 'a LOCAL_MUTATION model proposal cannot be executed without approval'); eq(store.getPreferences().sessionMemoryEnabled, true, 'nothing changed');
  await muRow.getByRole('button', { name: /Examiner/ }).click();
  await page.getByTestId('cmp-digest').waitFor(); eq(await page.getByTestId('cmp-proposed-by').getAttribute('data-proposed-by'), 'MODEL', 'review shows the model origin');
  eq(await page.getByTestId('cmp-confirm').getAttribute('data-kind'), 'SIMPLE_CONFIRM');
  await page.evaluate(() => document.querySelector('[data-testid="cmp-btn-confirm"]').click());
  await page.locator('[role=alert][data-error-code="APPROVAL_REQUIRED"]').waitFor(); eq(await state(), 'PENDING', 'synthetic click refused for a model proposal');
  const changedBefore = store.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length;
  await approveExecute(); eq(store.getPreferences().sessionMemoryEnabled, false, 'model-proposed mutation applied after human approval');
  eq(store.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length, changedBefore + 1, 'mutation executed exactly once');
  const modelApproval = approvals.at(-1); eq(modelApproval.proposalId, mu.proposalId);
  const modelReplay = await page.evaluate(async ({ approvalId, actionId }) => { const r = await fetch('/api/companion/executions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId, actionId, parameters: { sessionMemoryEnabled: false }, executionId: 'replay-model-0001' }) }); return r.json(); }, { approvalId: modelApproval.approvalId, actionId: mu.actionId });
  eq(modelReplay.error?.code, 'APPROVAL_ALREADY_USED', 'model approval replay refused');
  eq(actions.user.getProposal(mu.proposalId).status, 'EXECUTED');
  await closeReview();
  // READ_ONLY model proposal: no confirmation (class rule), only a trusted click on the read-only control.
  const approvalsBeforeRo = approvals.length;
  await page.locator(`[data-proposal-id="${ro.proposalId}"]`).getByRole('button', { name: /Examiner/ }).click();
  await page.getByTestId('cmp-btn-run-readonly').waitFor();
  eq(await page.getByTestId('cmp-btn-confirm').count(), 0, 'READ_ONLY has no artificial confirmation');
  await page.evaluate(() => document.querySelector('[data-testid="cmp-btn-run-readonly"]').click());
  await page.locator('[role=alert][data-error-code="APPROVAL_REQUIRED"]').waitFor(); eq(actions.user.getProposal(ro.proposalId).status, 'PENDING', 'synthetic click does not run it');
  await page.getByTestId('cmp-btn-run-readonly').click();
  ok(await waitState('EXECUTED'), 'READ_ONLY model proposal executed'); eq(await page.getByTestId('cmp-result').getAttribute('data-success'), 'true');
  eq(actions.user.getProposal(ro.proposalId).status, 'EXECUTED'); eq(approvals.length, approvalsBeforeRo, 'no approval for READ_ONLY');
  eq(actions.audit.list().filter(e => e.event === 'ACTION_EXECUTED' && e.proposalId === ro.proposalId).length, 1, 'read-only executed once');
  await closeReview();
  for (const id of [mu.proposalId, ro.proposalId]) await page.locator(`[data-proposal-id="${id}"]`).waitFor({ state: 'detached', timeout: 5_000 }); // the panel reload is async
  eq(await page.locator(`[data-proposal-id="${mu.proposalId}"], [data-proposal-id="${ro.proposalId}"]`).count(), 0, 'executed proposals leave the list');

  // Approval expiry is visible, execution disabled, and Escape restores focus to the opener.
  const expiryOpener = page.locator('button[data-pref="proposalEnabled"]'); await expiryOpener.focus(); await page.keyboard.press('Enter');
  await page.getByTestId('cmp-digest').waitFor(); await page.getByTestId('cmp-btn-confirm').focus(); await page.keyboard.press('Enter'); ok(await waitState('APPROVED'), 'keyboard approval');
  ok(await waitState('EXPIRED', 9_000), 'approval expires'); ok(await page.getByTestId('cmp-btn-execute').isDisabled(), 'expired approval cannot execute');
  await page.keyboard.press('Escape'); await page.getByTestId('cmp-review').waitFor({ state: 'detached' }); ok(await expiryOpener.evaluate(el => el === document.activeElement), 'focus restored after Escape');

  // Memory OFF remains an approved action; forget stays available.
  await page.locator('button[data-pref="memoryEnabled"]').click(); await page.getByTestId('cmp-digest').waitFor(); await approveExecute(); await closeReview();
  await page.getByTestId('cmp-memory-off').waitFor();
  for (const key of ['durableRetrieval', 'sessionMemory', 'proposals', 'contextMemory']) eq(await page.locator(`[data-contract="${key}"]`).innerText(), 'OFF', `${key} OFF`);
  eq(await page.locator('[data-contract="forget"]').innerText(), 'Disponible'); eq(memory.preferences().memoryEnabled, false);

  ok(apiEvents.some(x => x === 'GET /api/companion/status') && apiEvents.some(x => x === 'POST /api/companion/proposals'), 'typed route exercised');
  ok(!apiEvents.some(x => /rpc/i.test(x)), 'no generic RPC route');
  eq(actions.approvalChannel, 'UI_GESTURE');
  eq(store.schemaVersion(), 4, 'schema 4 (additive activation-state migration)'); eq(store.listModelAudit().length, 0, 'model stayed NOT_RUN');
  eq(external.length, 0, `external requests: ${external.join(', ')}`); eq(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(realDb.map(sha), realBefore); assertions += 1;
  console.log(`PASS COMP-6B product browser: ${assertions} assertions, typed route + real App + UI_GESTURE approvals`);
} finally {
  await context.close(); await browser.close(); await vite.close();
  await new Promise(resolve => apiServer.close(resolve));
  try { store.close(); } catch { /* closed */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}
