// NB-7 UI check — Docteur Memory in the MAIN CHAT (real src/App.tsx, fully mocked network; never the real dev server / DB).
// Covers: default ON + explicit project / notebook selection sent with the question, toggle OFF ⇒ use_memory:false and no project keys,
// "Mémoire utilisée : N" collapsed by default and expandable (statement, scope, type, provenance, evidence link, historical flag),
// no indicator when no memory was used, typed notebook sources + conflict notice, hostile-string XSS (statements, evidence, project /
// notebook names, source titles), no memory content in browser storage, offline (non-loopback aborted), keyboard accessibility.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startHarness, openApp, sleep, until } from './audit-queue-lib.mjs';

let assertions = 0; const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const IMG = '<img src=x onerror="window.__xssFired=true">'; const SCRIPT = '<script>window.__xssFired=true</script>';
const watchdog = setTimeout(() => { console.error('CHAT MEMORY browser deadline'); process.exit(1); }, 300_000);
let h; const answers = []; let scenario = 'memory';

const used = (over = {}) => ({ marker: 'M1', memoryId: 'nmem-1', type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'docteur', notebookId: null }, status: 'APPROVED', isHistorical: false, score: 0.0312, reason: 'FTS',
  statement: `Device Fabric est gelé ${IMG}`, provenance: `Approuvé le 2026-09-30 · issu de 2 message(s) (CHATGPT) ${SCRIPT}`, trustLevel: 'PAST_AI_OUTPUT', effectiveFrom: '2026-02-01T00:00:00.000Z', effectiveUntil: null,
  evidence: [{ kind: 'AI_HISTORY_MESSAGE', ref: 'm1', provider: `CHATGPT ${IMG}`, status: 'OK' }, { kind: 'AI_HISTORY_MESSAGE', ref: 'm2', provider: 'CLAUDE', status: 'SOURCE_MISSING' }], ...over });
const answerBody = (b) => {
  const base = { answer: 'Voici la réponse [M1].', sources: [], latency_ms: 5, model_used: 'llama3.2:3b', router_level: 0 };
  if (scenario === 'none') return { ...base, memoryUsed: [], memory: { enabled: true, requestId: 'r0', notice: 'NO_RELEVANT_MEMORY', conflicts: [], skipped: [], citedMemoryIds: [], citedSources: [] }, citations: [] };
  if (b.use_memory === false) return { ...base, memoryUsed: [], memory: { enabled: false, requestId: null, notice: 'MEMORY_OFF', conflicts: [], skipped: [], citedMemoryIds: [], citedSources: [] }, citations: [] };
  const u = [used(), used({ marker: 'M2', memoryId: 'nmem-2', type: 'PREFERENCE', scope: { kind: 'GLOBAL', projectId: null, notebookId: null }, isHistorical: true, status: 'SUPERSEDED', statement: 'Ancienne préférence', evidence: [] })];
  return { ...base, has_private_sources: true, routing_reason: 'mémoire · local imposé', memoryUsed: u,
    memory: { enabled: true, requestId: 'r1', notice: null, retrievalMode: 'HYBRID', vectorStatus: 'READY', historical: false, project: b.memory_project ?? null, notebook: b.memory_notebook ?? null, conflicts: scenario === 'conflict' ? [{ conflictId: null, kind: 'POLARITY', between: ['M1', 'S1'] }] : [], skipped: [], citedMemoryIds: ['nmem-1'], citedSources: [], timingMs: 4 },
    notebookSources: b.memory_notebook ? [{ marker: 'S1', type: 'DOCUMENT_CHUNK', id: 'chunk-1', ref: 'DOCUMENT_CHUNK:chunk-1', title: `Spec ${IMG}`, trustLevel: 'PRIMARY_SOURCE' }, { marker: 'S2', type: 'AI_HISTORY_MESSAGE', id: 'chunk-2', ref: 'AI_HISTORY_MESSAGE:chunk-2', title: 'Discussion', trustLevel: 'PAST_AI_OUTPUT' }] : [],
    citations: [{ type: 'MEMORY', id: 'nmem-1', marker: 'M1' }] };
};

try {
  h = await startHarness({ port: 5232 });
  const app = await openApp(h, { playlists: {}, extra: async ({ route, p, m, body, json }) => {
    if (p === '/api/answer' && m === 'POST') { const b = body(); answers.push(b); await json(route, answerBody(b)); return true; }
    if (p === '/api/docteur-memory/status') { await json(route, { strict_local: true, projects: [{ projectId: 'docteur', name: `Docteur ${IMG}` }, { projectId: 'boutique', name: 'Boutique' }], counts: { approved: 2, superseded: 0, revoked: 0, archived: 0 }, vector: { total: 2, missing: 0, incompatible: 0, needsReindex: false }, constants: { MEMORY_TYPES: [], MAX_STATEMENT_CHARS: 400 } }); return true; }
    if (p === '/api/notebooks' && m === 'GET') { await json(route, { notebooks: [{ id: 'nb1', title: `Dossier ${SCRIPT}`, description: '', privacy: true, egress_policy: 'local_only', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_count: 0 }] }); return true; }
    return false;
  } });
  const { page, net } = app; await sleep(1500);
  await page.addInitScript(() => { window.__xssFired = undefined; });
  const ask = async (q) => { const before = answers.length; const box = page.locator('input[placeholder^="Question"], input[placeholder^="🔒"]').first(); await box.fill(q); await box.press('Enter'); await until(async () => answers.length > before, 20_000, 100); await page.getByTestId('chat-memory-used').or(page.getByText('Voici la réponse')).first().waitFor({ timeout: 20_000 }); await sleep(2500); };

  await page.keyboard.press('Control+l'); await sleep(800); await page.getByRole('button', { name: /QUESTION/ }).click(); await sleep(500);
  const controls = page.getByTestId('chat-memory-controls'); await controls.waitFor();
  check((await page.getByTestId('chat-memory-toggle').innerText()).includes('ON') && (await page.getByTestId('chat-memory-toggle').getAttribute('aria-checked')) === 'true', 'memory defaults to ON (visible, switchable)');
  check((await controls.innerText()).includes('sans projet'), 'hint: without a project only GLOBAL memory can serve');
  const projOpts = await page.getByTestId('chat-memory-project').locator('option').allInnerTexts(); check(projOpts.length === 3 && projOpts[0].includes('aucun') && projOpts[1].includes('<img'), 'project list from the registry; hostile name shown as text');
  check((await page.locator('[data-testid="chat-memory-controls"] img').count()) === 0, 'no element injected through project / notebook names');

  // 1. explicit context is sent; no guessing
  await ask('Device Fabric est-il gelé ?');
  check(answers.at(-1).use_memory === true && !('memory_project' in answers.at(-1)) && !('memory_notebook' in answers.at(-1)), 'no project selected ⇒ no memory_project key is sent (never guessed)');
  await page.getByTestId('chat-memory-project').selectOption('docteur'); await page.getByTestId('chat-memory-notebook').selectOption('nb1');
  await ask('Device Fabric est-il gelé (contexte explicite) ?');
  check(answers.at(-1).memory_project === 'docteur' && answers.at(-1).memory_notebook === 'nb1' && answers.at(-1).use_memory === true, 'explicit project + notebook selections are sent');

  // 2. memory-used panel: collapsed, expandable, typed, XSS-safe
  const panel = page.getByTestId('chat-memory-used').last();
  check((await page.getByTestId('chat-memory-used-summary').last().innerText()).includes('Mémoire utilisée : 2') && (await page.getByTestId('chat-memory-used-summary').last().innerText()).includes('sources Notebook : 2'), '« Mémoire utilisée : N » shown with the Notebook sources count');
  check(!(await panel.evaluate(el => el.open)), 'collapsed by default');
  await page.getByTestId('chat-memory-used-summary').last().click(); check(await panel.evaluate(el => el.open), 'expands on click');
  const items = panel.getByTestId('chat-memory-item'); check((await items.count()) === 2, 'both memories listed');
  const t0 = await items.nth(0).innerText(); check(t0.includes('[M1]') && t0.includes('PROJET docteur') && t0.includes('DECISION') && t0.includes('FTS') && t0.includes('Approuvé le 2026-09-30') && t0.includes('<img src=x'), 'marker, scope, type, reason/score, statement and provenance shown (hostile markup as text)');
  check((await items.nth(0).getByTestId('chat-memory-evidence').innerText()).includes('(source supprimée)'), 'evidence links (deleted source flagged)');
  check((await items.nth(1).getByTestId('chat-memory-historical').count()) === 1 && (await items.nth(1).innerText()).includes('GLOBAL'), 'historical memory flagged');
  const srcs = panel.getByTestId('chat-notebook-source'); check((await srcs.count()) === 2 && (await srcs.nth(0).innerText()).includes('DOCUMENT_CHUNK') && (await srcs.nth(1).innerText()).includes('ancienne réponse IA, non vérifiée'), 'Notebook sources are a distinct, typed list (AI history flagged unverified)');
  check((await page.evaluate(() => window.__xssFired)) === undefined && (await page.locator('[data-testid="chat-memory-used"] img, [data-testid="chat-memory-used"] script').count()) === 0, 'no XSS through statements, provenance, evidence, source titles');
  check((await page.locator('select option img, select option script').count()) === 0, 'no XSS through project / notebook names');

  // 3. conflict notice
  scenario = 'conflict'; await ask('Device Fabric conflit ?'); check((await page.getByTestId('chat-memory-conflict').last().textContent()).includes('n\'est pas une vérité supérieure'), 'memory ↔ source conflict surfaced'); scenario = 'memory';

  // 4. OFF
  await page.getByTestId('chat-memory-toggle').click(); check((await page.getByTestId('chat-memory-toggle').innerText()).includes('OFF') && (await page.getByTestId('chat-memory-project').count()) === 0, 'toggle OFF hides the context selectors');
  const nUsed = await page.getByTestId('chat-memory-used').count(); await ask('Device Fabric est-il gelé (OFF) ?');
  check(answers.at(-1).use_memory === false && !('memory_project' in answers.at(-1)) && !('memory_notebook' in answers.at(-1)), 'OFF ⇒ use_memory:false and no project / notebook sent');
  check((await page.getByTestId('chat-memory-used').count()) === nUsed, 'OFF ⇒ no memory indicator for that answer');
  await page.getByTestId('chat-memory-toggle').click();

  // 5. no-memory case: indicator absent
  scenario = 'none'; const before = await page.getByTestId('chat-memory-used').count(); await ask('recette de tarte'); check((await page.getByTestId('chat-memory-used').count()) === before, 'no relevant memory ⇒ no indicator, no empty block');
  check((await page.getByText('Voici la réponse').count()) >= 1, 'the answer itself is unchanged'); scenario = 'memory';

  // 6. storage / keyboard / offline
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
  check(!/est gelé <img|Ancienne préférence|Approuvé le|CHATGPT|PAST_AI_OUTPUT/.test(stored) && stored.includes('docteur.chatMemory.v1'), 'only the switch / selections are persisted, never memory content');
  await page.getByTestId('chat-memory-toggle').focus(); check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'chat-memory-toggle'), 'toggle is keyboard-focusable'); await page.keyboard.press('Enter'); check((await page.getByTestId('chat-memory-toggle').getAttribute('aria-checked')) === 'false', 'Enter toggles (role=switch)'); await page.keyboard.press('Enter');
  check(net.external.length === 0, `offline: 0 external requests (${net.external.join(',')})`);
  const errs = net.errors.filter(e => !/outputs is not iterable/.test(e)); check(errs.length === 0, `no page error: ${errs.join(' | ')}`);
  console.log(`CHAT MEMORY browser: ${assertions} assertions OK`);
} catch (e) { console.error('CHAT MEMORY browser FAILED:', e.message); process.exitCode = 1; } finally { clearTimeout(watchdog); await h?.browser.close(); await h?.server.close(); }
void fs;
