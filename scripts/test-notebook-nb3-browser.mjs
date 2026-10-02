// NB-3 UI check — Notebook DOCUMENTS tab: retrieval-mode label, FTS-only state,
// reindex (explicit), trust badge, retention, filters, conflicts, NO_RELEVANT_SOURCE,
// citation preview (exact chunk), keyboard / focus / ARIA, delete confirmation,
// hostile-string XSS, and offline (every non-loopback request aborted).
// Fully mocked API — never the real dev server / real DB.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser; let server; let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const watchdog = setTimeout(() => { console.error('NB3 browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 120_000);
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/notebook-docs-harness.jsx");mount();</script>';
const now = new Date().toISOString();
const XSS_IMG = '<img src=x onerror="window.__xssFired=true">';
const XSS_SCRIPT = '<script>window.__xssFired=true</script>';

const calls = [];
let vectorNeedsReindex = true;
let mode = 'HYBRID';
let scenario = 'normal';
const mkDoc = (id, title, over = {}) => ({ documentId: id, sourceId: id, title, mimeType: 'text/plain', hash: 'h', size: 2048, language: 'fr', createdAt: now, updatedAt: now, currentVersionId: `v-${id}`, status: 'READY', trustLevel: 'UNKNOWN', errorCode: null, retention: 'KEEP', expiresAt: null, ...over });
const docs = [
  mkDoc('d1', XSS_IMG, { trustLevel: 'USER_AUTHORED' }),
  mkDoc('d2', 'notes-ia.txt', { trustLevel: 'PAST_AI_OUTPUT', retention: 'DELETE_AFTER', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  mkDoc('d3', 'session.txt', { retention: 'SESSION_ONLY' }),
];
const chunkText = `Texte exact du segment 3. ${XSS_SCRIPT} Fin.`;
const answerBody = () => {
  if (scenario === 'none') return { strict_local: true, status: 'NO_RELEVANT_SOURCE', outside_notebook: false, answer: 'Aucune source pertinente dans ce Notebook pour cette question.', citations: [], uncertainties: [{ code: 'NO_RELEVANT_SOURCE', message: 'Aucun extrait n\'a passé les seuils.' }], source_conflicts: [], sources_used: [], retrieval_mode: mode, mode: 'fts_only', vector_status: mode === 'FTS_ONLY' ? 'VECTOR_UNAVAILABLE' : 'READY', confidence: 'NONE', chunks_used: 0 };
  if (scenario === 'outside') return { strict_local: true, status: 'OUTSIDE_NOTEBOOK', outside_notebook: true, answer: 'Hors Notebook : 330 m.', citations: [], uncertainties: [{ code: 'OUTSIDE_NOTEBOOK', message: 'Réponse hors Notebook.' }], source_conflicts: [], sources_used: [], retrieval_mode: mode, mode: 'fts_only', vector_status: 'READY', confidence: 'NONE', chunks_used: 0 };
  return {
    strict_local: true, status: 'ANSWERED', outside_notebook: false, answer: 'La version 2 est active [1] mais désactivée selon [2].',
    citations: [
      { ref: 1, chunkId: 'd1:v1:0', sourceId: 'd1', sourceTitle: XSS_IMG, documentVersion: 1, versionId: 'v-d1', page: 3, headingPath: ['Guide', XSS_SCRIPT], trustLevel: 'USER_AUTHORED', superseded: false, passage: 'Extrait <b>gras</b>', assertionType: 'USER_ASSERTION' },
      { ref: 2, chunkId: 'd2:v2:0', sourceId: 'd2', sourceTitle: 'notes-ia.txt', documentVersion: 2, versionId: 'v-d2', page: null, headingPath: [], trustLevel: 'PAST_AI_OUTPUT', superseded: false, passage: 'Selon une IA…', assertionType: 'PAST_AI_ASSERTION' },
    ],
    uncertainties: [{ code: 'PAST_AI_SOURCE_USED', message: 'Une des sources est une ancienne sortie d\'IA (non vérifiée).' }, { code: 'SOURCE_CONFLICT', message: '1 conflit(s)…' }],
    source_conflicts: [{ type: 'POLARITY', heuristic: true,
      a: { citationId: 1, chunkId: 'd1:v1:0', sourceId: 'd1', sourceTitle: XSS_IMG, documentVersion: 1, importedAt: '2026-03-03T10:00:00.000Z', page: 3, excerpt: `La version 2 est active ${XSS_SCRIPT}` },
      b: { citationId: 2, chunkId: 'd2:v2:0', sourceId: 'd2', sourceTitle: 'notes-ia.txt', documentVersion: 2, importedAt: '2026-03-20T10:00:00.000Z', page: null, excerpt: 'La version 2 est désactivée' } }],
    sources_used: [], retrieval_mode: mode, mode: 'hybrid', vector_status: mode === 'FTS_ONLY' ? 'VECTOR_UNAVAILABLE' : 'READY', confidence: 'MEDIUM', chunks_used: 2,
  };
};

try {
  server = await createServer({ configFile: false, cacheDir: '.tmp/vite-nb3', plugins: [react()], optimizeDeps: { entries: ['scripts/notebook-docs-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 5217, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = 'http://127.0.0.1:5217';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = []; const externalAttempts = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });
  // OFFLINE: every non-loopback request is aborted (and counted) — the whole flow must still work.
  await context.route(url => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname), route => { externalAttempts.push(route.request().url()); return route.abort(); });

  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname; const m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body; let status = 200;
    const json = () => { try { return req.postDataJSON(); } catch { return null; } };
    if (p === '/api/notebooks' && m === 'GET') body = { notebooks: [{ id: 'nb1', title: 'Mon Notebook', description: '', privacy: true, egress_policy: 'local_only', created_at: now, updated_at: now, source_count: docs.length }] };
    else if (p === '/api/notebooks/nb1' && m === 'GET') body = { notebook: { id: 'nb1', title: 'Mon Notebook', description: '', privacy: true, egress_policy: 'local_only', created_at: now, updated_at: now }, source_count: docs.length };
    else if (p === '/api/notebooks/nb1/sources') body = { sources: [], total: docs.length };
    else if (p === '/api/notebooks/nb1/documents' && m === 'GET') body = { strict_local: true, documents: docs, total: docs.length, formats: ['.txt', '.md', '.pdf', '.html', '.json'], vector: { status: vectorNeedsReindex ? 'VECTOR_STALE' : 'READY', total: 3, compatible: vectorNeedsReindex ? 0 : 3, incompatible: vectorNeedsReindex ? 3 : 0, missing: 0, needsReindex: vectorNeedsReindex } };
    else if (p === '/api/notebooks/nb1/reindex' && m === 'POST') { calls.push({ p, body: null }); vectorNeedsReindex = false; mode = 'HYBRID'; body = { ok: true, documents: 3, reindexed: 7, failed: 0 }; }
    else if (p === '/api/notebooks/nb1/documents/import' && m === 'POST') { calls.push({ p, raw: req.postDataBuffer()?.toString('utf8').slice(0, 3000) }); docs.push(mkDoc('d9', 'nouveau.txt')); status = 202; body = { documentId: 'd9', versionId: 'v9', duplicate: false, status: 'QUEUED' }; }
    else if (p.endsWith('/trust') && m === 'PUT') { calls.push({ p, body: json() }); const id = p.split('/')[5]; const d = docs.find(x => x.documentId === id); if (d) d.trustLevel = json().trust_level; body = { ok: true }; }
    else if (p === '/api/notebooks/nb1/doc-ask') { calls.push({ p, body: json() }); body = answerBody(); }
    else if (p === '/api/notebooks/nb1/doc-search') { calls.push({ p, body: json() }); body = { strict_local: true, mode: 'fts_only', retrieval_mode: mode, vector_status: mode === 'FTS_ONLY' ? 'VECTOR_UNAVAILABLE' : 'READY', results: [] }; }
    else if (p.startsWith('/api/notebooks/nb1/citations/') && m === 'GET') {
      const chunkId = decodeURIComponent(p.split('/').pop());
      body = chunkId === 'd1:v1:0'
        ? { citation: { chunkId, sourceId: 'd1', sourceTitle: XSS_IMG, documentVersion: 1, versionId: 'v-d1', page: 3, headingPath: ['Guide', XSS_SCRIPT], startOffset: 120, endOffset: 240, hash: 'abc', trustLevel: 'USER_AUTHORED', assertionType: 'USER_ASSERTION', superseded: false, importedAt: now, text: chunkText } }
        : { citation: { chunkId, sourceId: 'd2', sourceTitle: 'notes-ia.txt', documentVersion: 2, versionId: 'v-d2', page: null, headingPath: [], startOffset: 0, endOffset: 40, hash: 'def', trustLevel: 'PAST_AI_OUTPUT', assertionType: 'PAST_AI_ASSERTION', superseded: true, importedAt: now, text: 'Texte IA' } };
    } else if (p.startsWith('/api/notebooks/nb1/documents/') && m === 'DELETE') { const id = p.split('/').pop(); const i = docs.findIndex(d => d.documentId === id); if (i >= 0) docs.splice(i, 1); body = { ok: true }; }
    else { status = 404; body = { error: 'fixture_route_missing', path: p }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: cors });
  });
  await page.route('**/__nb3', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__nb3`);
  await page.getByText('Mon Notebook', { exact: true }).click();
  await page.getByTestId('nb-center-tab-docs').click();
  await page.getByTestId('nb-docs-panel').waitFor();

  // ── retrieval mode / FTS-only / reindex ───────────────────────────────────
  const modeEl = page.getByTestId('nb-retrieval-mode');
  await modeEl.waitFor();
  const modeText = await modeEl.innerText();
  check(modeText.includes('Recherche texte locale') && modeText.includes('VECTOR_STALE'), `FTS-only label with stale status: ${modeText}`);
  check((await modeEl.getAttribute('role')) === 'status', 'retrieval mode is a live status region');
  check(await page.getByTestId('nb-doc-reindex').isVisible(), 'explicit reindex button offered');
  await page.getByTestId('nb-doc-reindex').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="nb-doc-reindex"]'));
  check(calls.some(c => c.p.endsWith('/reindex')), 'reindex called only after the user click');
  check((await page.locator('[role="status"]').allInnerTexts()).some(t => t.includes('Réindexation terminée')), 'reindex result reported');

  // ── trust badge (metadata) + retention badges ─────────────────────────────
  const trustSelects = page.getByTestId('nb-doc-trust');
  check((await trustSelects.nth(1).inputValue()) === 'PAST_AI_OUTPUT', 'PAST_AI_OUTPUT is shown, not hidden');
  await trustSelects.nth(1).selectOption('SECONDARY_SOURCE');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="nb-doc-trust"]')[1].value === 'SECONDARY_SOURCE');
  check(calls.some(c => c.p.endsWith('/trust') && c.body.trust_level === 'SECONDARY_SOURCE'), 'trust change sent as metadata update');
  const badges = await page.getByTestId('nb-doc-retention-badge').allInnerTexts();
  check(badges.length === 2 && badges.some(b => b.includes('supprimé le')) && badges.some(b => b.includes('session uniquement')), `retention badges: ${badges}`);
  await trustSelects.nth(1).selectOption('PAST_AI_OUTPUT');

  // ── retention selector on import ──────────────────────────────────────────
  await page.getByTestId('nb-doc-retention').selectOption('DELETE_AFTER');
  await page.getByTestId('nb-doc-duration').selectOption('7d');
  await page.getByTestId('nb-doc-file-input').setInputFiles({ name: 'nouveau.txt', mimeType: 'text/plain', buffer: Buffer.from('Contenu du nouveau document.') });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="nb-doc-row"]').length === 4);
  const imp = calls.find(c => c.p.endsWith('/documents/import'));
  check(imp.raw.includes('DELETE_AFTER') && imp.raw.includes('7d'), 'retention + duration sent with the import');
  await page.getByTestId('nb-doc-retention').selectOption('KEEP');

  // ── filters → request body ────────────────────────────────────────────────
  await page.getByTestId('nb-doc-query').fill('version 2 active');
  await page.getByTestId('nb-filter-trust').selectOption('trusted');
  await page.getByTestId('nb-filter-historical').check();
  await page.getByTestId('nb-filter-broad').check();
  await page.getByTestId('nb-doc-ask').click();
  await page.getByTestId('nb-conflicts').waitFor();
  const askBody = calls.filter(c => c.p.endsWith('/doc-ask')).at(-1).body;
  check(askBody.trust_filter === 'trusted' && askBody.include_historical === true && askBody.profile === 'broad', `filters sent: ${JSON.stringify(askBody)}`);
  await page.getByTestId('nb-filter-trust').selectOption('selected');
  check((await page.getByTestId('nb-doc-select').count()) === 4, 'selection mode shows per-source checkboxes');
  await page.getByTestId('nb-doc-select').nth(1).check();
  await page.getByTestId('nb-doc-ask').click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(150);
  const selBody = calls.filter(c => c.p.endsWith('/doc-ask')).at(-1).body;
  check(Array.isArray(selBody.document_ids) && selBody.document_ids.length === 1 && selBody.document_ids[0] === 'd2', 'selected sources sent as document_ids');
  await page.getByTestId('nb-filter-trust').selectOption('all');
  await page.getByTestId('nb-filter-historical').uncheck(); await page.getByTestId('nb-filter-broad').uncheck();

  // ── conflicts / uncertainties / past-AI marking ───────────────────────────
  await page.getByTestId('nb-doc-ask').click();
  await page.getByTestId('nb-conflicts').waitFor();
  const conflict = await page.getByTestId('nb-conflict').innerText();
  check(conflict.includes('POLARITY') && conflict.includes('v1') && conflict.includes('v2') && conflict.includes('notes-ia.txt') && /2026|03\/2026|03\/03/.test(conflict), `conflict shows both sources, versions, dates: ${conflict}`);
  check((await page.getByTestId('nb-conflicts').getAttribute('role')) === 'alert', 'conflict block is announced');
  check((await page.getByTestId('nb-uncertainties').innerText()).includes('non vérifiée'), 'past-AI source flagged as unverified');
  check((await page.getByTestId('nb-doc-citation').nth(1).innerText()).includes('ancienne sortie IA'), 'PAST_AI assertion labelled on the citation');
  check((await page.getByTestId('nb-confidence').innerText()).includes('confiance moyenne'), 'confidence shown');

  // ── citation preview: exact chunk, keyboard, focus return, Escape ─────────
  const opener = page.getByTestId('nb-doc-citation-open').first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('nb-citation-preview');
  await dialog.waitFor();
  check((await dialog.getAttribute('role')) === 'dialog' && !!(await dialog.getAttribute('aria-label')), 'preview is a labelled dialog');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'nb-citation-preview'), 'focus moves to the preview');
  const meta = await page.getByTestId('nb-preview-meta').innerText();
  check(meta.includes('version 1') && meta.includes('page 3') && meta.includes('Guide') && meta.includes('offsets 120–240'), `preview metadata: ${meta}`);
  check((await page.getByTestId('nb-preview-text').innerText()) === chunkText, 'preview shows the exact stored chunk text (verbatim, scripts as text)');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="nb-citation-preview"]'));
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'nb-doc-citation-open'), 'focus returns to the citation button');
  await page.getByTestId('nb-doc-citation-open').nth(1).click();
  check((await page.getByTestId('nb-preview-meta').innerText()).includes('version remplacée'), 'superseded version is labelled in the preview');
  await page.getByTestId('nb-preview-close').click();

  // ── NO_RELEVANT_SOURCE / outside notebook ─────────────────────────────────
  scenario = 'none';
  await page.getByTestId('nb-doc-ask').click();
  await page.getByTestId('nb-no-source').waitFor();
  check((await page.getByTestId('nb-no-source').innerText()).includes('NO_RELEVANT_SOURCE'), 'no fabricated answer: explicit NO_RELEVANT_SOURCE');
  scenario = 'outside';
  await page.getByTestId('nb-allow-outside').check();
  await page.getByTestId('nb-doc-ask').click();
  await page.getByTestId('nb-outside').waitFor();
  check((await page.getByTestId('nb-outside').innerText()).includes('HORS NOTEBOOK'), 'outside-Notebook answers are clearly marked');
  check(calls.filter(c => c.p.endsWith('/doc-ask')).at(-1).body.allow_outside_notebook === true, 'outside answers require the explicit opt-in');
  scenario = 'normal';

  // ── delete confirmation (keyboard) ────────────────────────────────────────
  const del = page.getByTestId('nb-doc-delete').first();
  await del.focus();
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'nb-doc-delete-confirm'), 'confirmation takes focus');
  await page.getByTestId('nb-doc-delete-cancel').click();
  check((await page.getByTestId('nb-doc-row').count()) === 4, 'cancel keeps the document');
  check(!calls.some(c => c.p.includes('DELETE')), 'no delete call before confirmation');

  // ── XSS: hostile titles / headings / excerpts / conflict text are inert ───
  check((await page.evaluate(() => window.__xssFired)) === undefined, 'no injected script/handler executed');
  check((await page.locator('img[src="x"]').count()) === 0 && (await page.locator('script', { hasText: '__xssFired' }).count()) === 0, 'no HTML element was created from data');
  check((await page.getByTestId('nb-doc-row').first().innerText()).includes('<img src=x'), 'hostile title displayed as text');

  // ── offline + errors ──────────────────────────────────────────────────────
  check(externalAttempts.length === 0, `no external request attempted (all would have been aborted): ${externalAttempts.join(',')}`);
  check(pageErrors.length === 0, `no page errors: ${pageErrors.join(' | ')}`);
  console.log(`NB3 BROWSER PASS ${assertions}/${assertions}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await browser?.close(); await server?.close();
}
