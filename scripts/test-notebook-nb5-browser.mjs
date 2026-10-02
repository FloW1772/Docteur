// NB-5 UI check — "MÉMOIRE" tab of the Notebook modal (fully mocked API; never the real dev server / DB).
// Covers: candidate ≠ memory (no bulk approve), single-item approval with edit-before-approval, error handling
// (secret / personal data / duplicate / stale version), approved list (edit, revoke, archive, confirmed delete,
// evidence + revision history), supersession suggestions (explicit confirmation only), conflicts (both shown,
// human resolution), "Docteur a utilisé N souvenirs" (collapsed by default, expandable), unresolved-project
// notice, historical toggle, manual creation with 400-char limit, hostile-string XSS, ARIA / keyboard tabs,
// offline (every non-loopback request aborted), 0 page errors.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser; let server; let assertions = 0;
const check = (v, m) => { assert.ok(v, m); assertions += 1; };
const watchdog = setTimeout(() => { console.error('NB5 browser deadline'); void browser?.close(); void server?.close(); process.exitCode = 1; }, 150_000);
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/notebook-docs-harness.jsx");mount();</script>';
const now = new Date().toISOString();
const IMG = '<img src=x onerror="window.__xssFired=true">';
const SCRIPT = '<script>window.__xssFired=true</script>';

const calls = []; const writeTypes = [];
const until = async (fn) => { for (let i = 0; i < 80; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
let projects = []; let notebookProject = null; let seq = 100;
const mk = (id, statement, o = {}) => ({
  memoryId: id, statement, type: 'DECISION', status: 'APPROVED', scope: { kind: 'PROJECT', projectId: 'docteur', notebookId: null }, scopeKind: 'PROJECT', projectId: 'docteur', notebookId: null, confidence: 1, trustLevel: 'USER_AUTHORED',
  sensitivity: 'NORMAL', createdAt: now, updatedAt: now, approvedAt: now, effectiveFrom: '2026-02-01T00:00:00.000Z', effectiveUntil: null, supersededBy: null, sourceKind: 'MANUAL', sourceCandidateId: null, originalStatement: null,
  editedBeforeApproval: false, approvalSource: 'USER_UI', provenance: { origin: 'USER_AUTHORED_MANUAL' }, injectionFlags: [], version: 1, retention: 'KEEP', expiresAt: null, needsReview: false, provenanceStatus: 'MANUAL', ...o });
let items = [
  mk('m1', `Le serveur utilise seulement FTS ${IMG}`, { effectiveFrom: '2026-01-01T00:00:00.000Z' }),
  mk('m2', 'Le serveur utilise FTS5 et LanceDB en hybride', { effectiveFrom: '2026-06-01T00:00:00.000Z' }),
  mk('m3', 'Le mode furtif est activé en production', { type: 'PROJECT_FACT' }),
  mk('m4', `Le mode furtif est désactivé en production ${SCRIPT}`, { type: 'PROJECT_FACT', sensitivity: 'SENSITIVE', needsReview: true, injectionFlags: ['OVERRIDE_INSTRUCTIONS'], trustLevel: 'PAST_AI_OUTPUT', sourceKind: 'CANDIDATE', provenanceStatus: 'MISSING', editedBeforeApproval: true, originalStatement: 'Le mode est off' }),
  mk('m0', 'Ancienne décision : port 3939', { status: 'SUPERSEDED', effectiveUntil: '2026-03-01T00:00:00.000Z', supersededBy: 'm2' }),
  mk('mr', 'Souvenir révoqué de test', { status: 'REVOKED' }),
];
let suggestions = [{ suggestionId: 's1', newId: 'm2', oldId: 'm1', ambiguous: true, detail: 'même sujet, formulation différente', status: 'PENDING', createdAt: now }];
let conflicts = [{ conflictId: 'k1', memoryA: 'm3', memoryB: 'm4', kind: 'POLARITY', detail: 'x', status: 'OPEN', resolution: null, detectedAt: now }];
let candidates = [
  { candidateId: 'c1', type: 'DECISION', statement: `Nous avons décidé de garder ADMIN ${IMG}`, trustLevel: 'USER_AUTHORED', assertionType: 'USER_ASSERTION', confidence: 0.6, status: 'CANDIDATE', method: 'rule', statedAt: now, lastEvidenceAt: null, edited: false, orphaned: false, promotion: 'NONE', evidenceCount: 2, conversationCount: 1 },
  { candidateId: 'c-secret', type: 'DECISION', statement: 'Nous gardons la clé en clair', trustLevel: 'USER_AUTHORED', assertionType: 'USER_ASSERTION', confidence: 0.5, status: 'CANDIDATE', method: 'rule', statedAt: now, lastEvidenceAt: null, edited: false, orphaned: false, promotion: 'NONE', evidenceCount: 1, conversationCount: 1 },
  { candidateId: 'c-pii', type: 'PREFERENCE', statement: 'Contact : prenom@example.invalid', trustLevel: 'USER_AUTHORED', assertionType: 'USER_ASSERTION', confidence: 0.5, status: 'CANDIDATE', method: 'rule', statedAt: now, lastEvidenceAt: null, edited: false, orphaned: false, promotion: 'NONE', evidenceCount: 1, conversationCount: 1 },
  { candidateId: 'c-dup', type: 'DECISION', statement: 'Le mode furtif est activé en production', trustLevel: 'USER_AUTHORED', assertionType: 'USER_ASSERTION', confidence: 0.5, status: 'CANDIDATE', method: 'rule', statedAt: now, lastEvidenceAt: null, edited: false, orphaned: false, promotion: 'NONE', evidenceCount: 1, conversationCount: 1 },
  { candidateId: 'c-snip', type: 'SNIPPET', statement: 'extrait de code utile', trustLevel: 'PAST_AI_OUTPUT', assertionType: 'PAST_AI_ASSERTION', confidence: 0.5, status: 'CANDIDATE', method: 'rule', statedAt: now, lastEvidenceAt: null, edited: false, orphaned: false, promotion: 'NONE', evidenceCount: 1, conversationCount: 1 },
];
let scenario = 'normal';
const usedFor = () => (scenario === 'none' ? [] : [{ marker: 'M1', memoryId: 'm2', type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'docteur', notebookId: null }, status: 'APPROVED', statement: `Le serveur utilise FTS5 et LanceDB ${IMG}` },
  { marker: 'M2', memoryId: 'm0', type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'docteur', notebookId: null }, status: 'SUPERSEDED', statement: 'Ancienne décision : port 3939' }]);

try {
  server = await createServer({ configFile: false, cacheDir: '.tmp/vite-nb5', plugins: [react()], optimizeDeps: { entries: ['scripts/notebook-docs-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: 5219, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = 'http://127.0.0.1:5219';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); const page = await context.newPage();
  const pageErrors = []; const external = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });
  await context.route(url => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname), route => { external.push(route.request().url()); return route.abort(); });

  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const p = url.pathname; const m = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const bodyJson = () => { try { return req.postDataJSON(); } catch { return null; } };
    let body; let status = 200;
    const D = '/api/docteur-memory';
    if (p.startsWith(D) && ['POST', 'PATCH', 'PUT'].includes(m) && req.postData()) writeTypes.push(req.headers()['content-type'] ?? '');
    if (p === '/api/notebooks' && m === 'GET') body = { notebooks: [{ id: 'nb1', title: 'Mon Notebook', description: '', privacy: true, egress_policy: 'local_only', created_at: now, updated_at: now, source_count: 0 }] };
    else if (p === '/api/notebooks/nb1' && m === 'GET') body = { notebook: { id: 'nb1', title: 'Mon Notebook', description: '', privacy: true, egress_policy: 'local_only', created_at: now, updated_at: now }, source_count: 0 };
    else if (p === '/api/notebooks/nb1/sources') body = { sources: [], total: 0 };
    else if (p === '/api/notebooks/nb1/ai-history/candidates' && m === 'GET') { const list = candidates.filter(c => c.status === 'CANDIDATE' || c.status === 'APPROVED'); body = { strict_local: true, global_memory: false, candidates: list, total: list.length, types: ['DECISION'] }; }
    else if (p === `${D}/status`) body = { strict_local: true, projects, counts: { approved: items.filter(i => i.status === 'APPROVED').length, superseded: items.filter(i => i.status === 'SUPERSEDED').length, revoked: items.filter(i => i.status === 'REVOKED').length, archived: 0 }, vector: { total: 1, missing: 0, incompatible: scenario === 'reindex' ? 1 : 0, needsReindex: scenario === 'reindex' }, constants: { MEMORY_TYPES: [], MAX_STATEMENT_CHARS: 400 } };
    else if (p === `${D}/projects` && m === 'POST') { calls.push({ p, body: bodyJson() }); const b = bodyJson(); projects.push({ projectId: b.projectId, name: b.name }); status = 201; body = { project: { projectId: b.projectId, name: b.name } }; }
    else if (p === `${D}/notebooks/nb1/project` && m === 'GET') body = { notebookId: 'nb1', projectId: notebookProject };
    else if (p === `${D}/notebooks/nb1/project` && m === 'PUT') { calls.push({ p, body: bodyJson() }); notebookProject = bodyJson().projectId; body = { notebookId: 'nb1', projectId: notebookProject }; }
    else if (p === `${D}/items` && m === 'GET') { const st = url.searchParams.get('status'); const list = items.filter(i => !st || i.status === st); body = { items: list, total: list.length }; }
    else if (p === `${D}/items` && m === 'POST') { const b = bodyJson(); calls.push({ p, body: b }); if ((b.statement ?? '').length > 400) { status = 413; body = { error: 'Un souvenir est concis', code: 'MEMORY_TOO_LONG' }; } else { const it = mk(`m${++seq}`, b.statement, { type: b.type, sensitivity: b.sensitivity }); items.push(it); body = { memory: it, suggestions: 1, conflicts: 0, vector: 'READY' }; status = 201; } }
    else if (/\/candidates\/[^/]+\/approve$/.test(p) && m === 'POST') {
      const b = bodyJson(); const cid = p.split('/').at(-2); calls.push({ p, body: b });
      if (b.approve !== true) { status = 409; body = { error: 'Approbation humaine explicite requise', code: 'APPROVAL_REQUIRED' }; }
      else if (cid === 'c-secret') { status = 422; body = { error: 'Un secret a été détecté dans ce souvenir : approbation refusée (kinds : API_KEY)', code: 'SECRET_DETECTED' }; }
      else if (cid === 'c-pii' && !b.confirmSensitive) { status = 409; body = { error: 'Contenu personnel/sensible détecté : choisis SENSITIVE ou confirme', code: 'APPROVAL_REQUIRED', field: 'sensitivity' }; }
      else if (cid === 'c-dup' && !b.allowDuplicate) { status = 409; body = { error: 'Un souvenir identique existe déjà dans ce scope', code: 'DUPLICATE_MEMORY', duplicateOf: 'm3' }; }
      else if (cid === 'c-snip' && b.type === undefined) { status = 400; body = { error: 'type requis', code: 'UNSUPPORTED_TYPE' }; }
      else { const c = candidates.find(x => x.candidateId === cid); c.status = 'APPROVED'; c.promotion = 'MEMORY'; const it = mk(`m${++seq}`, b.statement, { type: b.type, sourceKind: 'CANDIDATE', sourceCandidateId: cid, editedBeforeApproval: b.statement !== c.statement, originalStatement: c.statement }); items.push(it); status = 201; body = { memory: it, suggestions: 0, conflicts: 0, vector: 'READY' }; }
    }
    else if (/\/items\/[^/]+\/revisions$/.test(p)) body = { revisions: [{ revisionId: 'r1', version: 1, action: 'APPROVE', oldStatement: null, newStatement: 'x', oldStatus: null, newStatus: 'APPROVED', reason: null, at: now }, { revisionId: 'r2', version: 2, action: 'EDIT', oldStatement: `ancien énoncé ${IMG}`, newStatement: 'y', oldStatus: 'APPROVED', newStatus: 'APPROVED', reason: null, at: now }] };
    else if (/\/items\/[^/]+$/.test(p) && m === 'GET') body = { memory: items.find(i => i.memoryId === p.split('/').pop()), usageCount: 3, evidence: [{ kind: 'AI_HISTORY_MESSAGE', ref: 'msg1', sourceId: 'i1', conversationId: 'cv1', provider: 'CHATGPT', role: 'USER', trustLevel: 'USER_AUTHORED', quote: `Nous avons décidé ${SCRIPT}`, ts: now, status: 'OK' }, { kind: 'AI_HISTORY_MESSAGE', ref: 'msg2', sourceId: 'i2', conversationId: 'cv2', provider: 'CLAUDE', role: 'ASSISTANT', trustLevel: 'PAST_AI_OUTPUT', quote: 'Réponse', ts: now, status: 'SOURCE_MISSING' }] };
    else if (/\/items\/[^/]+$/.test(p) && m === 'PATCH') { const b = bodyJson(); calls.push({ p, method: 'PATCH', body: b }); const it = items.find(i => i.memoryId === p.split('/').pop()); if (b.expectedVersion !== it.version) { status = 409; body = { error: 'Le souvenir a été modifié entre-temps : recharge-le', code: 'STALE_MEMORY_VERSION' }; } else { it.statement = b.statement; it.version += 1; body = { memory: it }; } }
    else if (/\/items\/[^/]+\/revoke$/.test(p) && m === 'POST') { calls.push({ p, body: bodyJson() }); const it = items.find(i => i.memoryId === p.split('/').at(-2)); it.status = 'REVOKED'; it.version += 1; body = { memory: it }; }
    else if (/\/items\/[^/]+\/archive$/.test(p) && m === 'POST') { calls.push({ p }); const it = items.find(i => i.memoryId === p.split('/').at(-2)); it.status = 'ARCHIVED'; body = { memory: it }; }
    else if (/\/items\/[^/]+$/.test(p) && m === 'DELETE') { calls.push({ p, method: 'DELETE', q: url.search }); items = items.filter(i => i.memoryId !== p.split('/').pop()); body = { ok: true }; }
    else if (p === `${D}/suggestions`) body = { suggestions: suggestions.map(s => ({ ...s, newMemory: items.find(i => i.memoryId === s.newId), oldMemory: items.find(i => i.memoryId === s.oldId) })) };
    else if (p === `${D}/supersede` && m === 'POST') { const b = bodyJson(); calls.push({ p, body: b }); const old = items.find(i => i.memoryId === b.oldId); old.status = 'SUPERSEDED'; old.supersededBy = b.newId; old.effectiveUntil = '2026-06-01T00:00:00.000Z'; suggestions = suggestions.filter(s => !(s.newId === b.newId && s.oldId === b.oldId)); body = { old, new: items.find(i => i.memoryId === b.newId) }; }
    else if (p === `${D}/supersede/dismiss` && m === 'POST') { calls.push({ p, body: bodyJson() }); suggestions = []; body = { ok: true }; }
    else if (p === `${D}/conflicts`) body = { conflicts: conflicts.map(c => ({ ...c, a: items.find(i => i.memoryId === c.memoryA), b: items.find(i => i.memoryId === c.memoryB) })) };
    else if (/\/conflicts\/[^/]+\/resolve$/.test(p) && m === 'POST') { calls.push({ p, body: bodyJson() }); conflicts = []; body = { ok: true }; }
    else if (p === `${D}/retrieve` && m === 'POST') { const b = bodyJson(); calls.push({ p, body: b }); const u = usedFor(); body = { requestId: 'rq1', retrievalMode: 'HYBRID', vectorStatus: 'READY', results: u.map(x => items.find(i => i.memoryId === x.memoryId)), conflicts: [], notice: b.activeProject ? null : 'PROJECT_UNRESOLVED_NO_PROJECT_MEMORY' }; }
    else if (p === `${D}/answer` && m === 'POST') { const b = bodyJson(); calls.push({ p, body: b }); body = { strict_local: true, requestId: 'rq2', answer: `D'après [M1] : hybride. ${IMG}`, memoryUsed: usedFor(), memoryCitations: [], conflicts: scenario === 'conflict' ? [{ conflictId: 'k1', kind: 'POLARITY', memoryA: 'm3', memoryB: 'm4', detail: 'x' }] : [], notice: b.activeProject ? null : 'PROJECT_UNRESOLVED_NO_PROJECT_MEMORY', retrievalMode: 'HYBRID', vectorStatus: 'READY', authority: 'CONTEXT_ONLY' }; }
    else if (p === `${D}/reindex` && m === 'POST') { calls.push({ p }); scenario = 'normal'; body = { ok: true, reindexed: 1, failed: 0 }; }
    else { status = 404; body = { error: 'fixture_route_missing', path: p }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: cors });
  });
  await page.route('**/__nb5', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__nb5`);
  await page.getByText('Mon Notebook', { exact: true }).click();
  await page.getByTestId('nb-center-tab-mem').click();
  await page.getByTestId('memory-panel').waitFor();
  check((await page.getByTestId('nb-strict-local-badge').innerText()).includes('STRICT LOCAL'), 'STRICT LOCAL badge visible on the memory tab');
  const banner = await page.getByTestId('mem-banner').innerText();
  check(/uniquement ce que tu as approuvé/.test(banner) && /jamais une instruction/.test(banner), 'banner: approved-only, context not instruction');
  check(!/(gemini cloud|openai|google drive|onedrive|cloud)/i.test((await page.locator('body').innerText()).replace(/notebooklm/gi, '')), 'no cloud control');

  // ── ARIA / keyboard ───────────────────────────────────────────────────────
  check((await page.getByRole('tablist', { name: 'Mémoire' }).count()) === 1 && (await page.getByRole('tab').count()) >= 7, 'tablist + 7 tabs exposed');
  await page.getByTestId('mem-tab-approved').focus(); await page.keyboard.press('ArrowRight');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'mem-tab-conflicts'), 'arrow keys move between tabs and focus');
  await page.keyboard.press('ArrowLeft');
  check((await page.getByTestId('mem-tab-approved').getAttribute('aria-selected')) === 'true', 'aria-selected follows keyboard');

  // ── Approved list: hostile strings are text, badges, evidence, revisions ──────
  await page.getByTestId('mem-list-approved').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-item"]').length >= 1);
  check((await page.getByTestId('mem-item').count()) === 4, '4 approved memories listed (superseded / revoked are elsewhere)');
  const first = await page.getByTestId('mem-statement').first().innerText();
  check(first.includes('<img src=x onerror='), 'hostile statement is displayed as text');
  check((await page.evaluate(() => window.__xssFired)) === undefined && (await page.locator('[data-testid="mem-list-approved"] img').count()) === 0, 'no XSS through statements');
  check((await page.getByTestId('mem-sensitivity').count()) === 1 && (await page.getByTestId('mem-needs-review').count()) === 1 && (await page.getByTestId('mem-injection-flag').count()) === 1, 'sensitivity, source-deleted and instruction-like badges');
  check((await page.getByTestId('mem-scope').first().innerText()).includes('PROJET docteur'), 'scope badge');
  await page.getByTestId('mem-detail').nth(3).click(); await page.getByTestId('mem-detail-panel').waitFor();
  check((await page.getByTestId('mem-evidence').count()) === 2 && (await page.getByTestId('mem-evidence').nth(1).innerText()).includes('[source supprimée]'), 'evidence links, deleted source flagged');
  check((await page.getByTestId('mem-revision').count()) === 2 && (await page.getByTestId('mem-detail-panel').innerText()).includes('Énoncé original du candidat'), 'revision history + original candidate statement');
  check((await page.evaluate(() => window.__xssFired)) === undefined, 'no XSS through evidence / revisions');
  await page.getByTestId('mem-detail-panel').getByRole('button', { name: 'Fermer' }).click();

  // ── Edit (optimistic version sent), revoke, archive, confirmed delete ────────────
  await page.getByTestId('mem-edit').nth(2).click();
  await page.getByTestId('mem-form-statement').fill('Le mode furtif est activé partout en production.');
  await page.getByTestId('mem-form-submit').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-form"]').length === 0);
  const patch = calls.find(c => c.method === 'PATCH');
  check(patch && patch.body.expectedVersion === 1 && patch.body.statement.includes('partout') && !('scope' in patch.body), 'edit sends expectedVersion and no scope change');
  await page.getByTestId('mem-revoke').nth(3).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-item"]').length === 3);
  check(calls.some(c => c.p.endsWith('/revoke') && c.body.expectedVersion === 1), 'revoke sends expectedVersion; list refreshes');
  await page.getByTestId('mem-archive').last().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-item"]').length === 2);
  check(calls.some(c => c.p.endsWith('/archive')), 'archive');
  await page.getByTestId('mem-delete').first().click();
  check((await page.getByTestId('mem-delete-confirm').count()) === 1 && !calls.some(c => c.method === 'DELETE'), 'delete needs an explicit confirmation before any call');
  await page.getByTestId('mem-delete-confirm').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-item"]').length === 1);
  check(calls.some(c => c.method === 'DELETE' && c.q.includes('expected_version=')), 'confirmed delete sends the version');

  // ── Supersession: suggestion only; confirmation required ─────────────────────
  items.push(mk('m1', 'Le serveur utilise seulement FTS', { effectiveFrom: '2026-01-01T00:00:00.000Z' })); // re-seed the old memory referenced by the suggestion
  if (!items.find(i => i.memoryId === 'm2')) items.push(mk('m2', 'Le serveur utilise FTS5 et LanceDB en hybride', { effectiveFrom: '2026-06-01T00:00:00.000Z' }));
  await page.getByTestId('mem-tab-superseded').click(); await page.getByTestId('mem-list-superseded').waitFor();
  await page.getByTestId('mem-suggestions').waitFor();
  check((await page.getByTestId('mem-suggestions').innerText()).includes('rien n\'est appliqué sans ta confirmation') && (await page.getByTestId('mem-suggestion').count()) === 1, 'suggestion shown with the no-automatic warning');
  check(!calls.some(c => c.p.endsWith('/supersede')), 'nothing superseded before the click');
  await page.getByTestId('mem-supersede-confirm').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-suggestion"]').length === 0);
  const sup = calls.find(c => c.p.endsWith('/supersede'));
  check(sup && sup.body.confirm === true && sup.body.newId === 'm2' && sup.body.oldId === 'm1', 'supersession request carries confirm:true');
  check((await page.getByTestId('mem-superseded-by').count()) >= 1, 'superseded memory shows its replacement');

  // ── Conflicts: both statements shown, human resolution ──────────────────────
  await page.getByTestId('mem-tab-conflicts').click(); await page.getByTestId('mem-conflict').waitFor();
  const ct = await page.getByTestId('mem-conflict').innerText();
  check(ct.includes('CONFLIT POSSIBLE') && ct.includes('activé') && ct.includes('désactivé'), 'both positions displayed');
  check((await page.evaluate(() => window.__xssFired)) === undefined, 'no XSS through conflicts');
  await page.getByTestId('mem-conflict-keep').click();
  await page.getByText('Aucun conflit ouvert.').waitFor();
  check(calls.some(c => c.p.endsWith('/resolve') && c.body.action === 'KEEP_BOTH'), 'conflict resolved only by an explicit choice');

  // ── Candidates: proposals, never bulk, edit-before-approval, error handling ────
  await page.getByTestId('mem-tab-candidates').click(); await page.getByTestId('mem-candidates').waitFor();
  check((await page.getByTestId('mem-candidates-banner').innerText()).includes('pas un souvenir') && (await page.getByTestId('mem-candidates-banner').innerText()).includes('tout approuver'), 'candidates banner: proposals, no approve-all');
  check((await page.getByRole('button', { name: /tout approuver|approve all|approuver tout/i }).count()) === 0, 'no bulk-approve control');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-candidate"]').length === 5);
  check((await page.getByTestId('mem-candidate').count()) === 5, '5 pending candidates');
  check((await page.getByText('CANDIDAT — pas encore un souvenir').count()) === 5, 'each candidate is labelled as not-yet-memory');
  // project is not defined: create + select
  await page.getByTestId('mem-project-new').fill('Docteur'); await page.getByTestId('mem-project-add').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="mem-project-select"]')?.querySelectorAll('option').length === 2);
  await page.getByTestId('mem-project-select').selectOption('docteur');
  check(await until(() => calls.some(c => c.p.endsWith('/nb1/project') && c.body.projectId === 'docteur')) && calls.some(c => c.p.endsWith('/projects') && c.body.projectId === 'docteur'), 'project created explicitly, then mapped to this notebook');
  // approve c1 with an edit
  await page.getByTestId('mem-approve-open').first().click();
  check((await page.getByTestId('mem-form-statement').inputValue()).includes('Nous avons décidé'), 'form pre-filled with the candidate statement');
  await page.getByTestId('mem-form-statement').fill('Device Fabric reste ADMIN uniquement.');
  await page.getByTestId('mem-form-scope').selectOption('PROJECT');
  await page.getByTestId('mem-form-submit').click();
  await page.getByTestId('mem-notice').waitFor();
  const ap = calls.find(c => c.p.endsWith('/c1/approve'));
  check(ap.body.approve === true && ap.body.statement === 'Device Fabric reste ADMIN uniquement.' && ap.body.scope.kind === 'PROJECT' && ap.body.scope.projectId === 'docteur' && ap.body.type === 'DECISION', 'approval: explicit approve:true, edited statement, scope, type');
  check((await page.getByTestId('mem-candidate').count()) === 4, 'approved candidate leaves the pending list');
  // secret → blocked
  await page.locator('[data-testid="mem-candidate"]', { hasText: 'clé en clair' }).getByTestId('mem-approve-open').click();
  await page.getByTestId('mem-form-submit').click(); await page.getByTestId('mem-form-error').waitFor();
  check((await page.getByTestId('mem-form-error').innerText()).includes('SECRET_DETECTED') && (await page.getByTestId('mem-redact').count()) === 1, 'secret refused with a clear code; redaction is an explicit opt-in');
  await page.getByRole('button', { name: 'Annuler' }).click();
  // personal data → needs confirmation
  await page.locator('[data-testid="mem-candidate"]', { hasText: 'prenom@example.invalid' }).getByTestId('mem-approve-open').click();
  await page.getByTestId('mem-form-submit').click(); await page.getByTestId('mem-confirm-sensitive').waitFor();
  check((await page.getByTestId('mem-form-error').innerText()).includes('APPROVAL_REQUIRED'), 'personal data requires explicit confirmation');
  await page.getByTestId('mem-confirm-sensitive').check(); await page.getByTestId('mem-form-submit').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mem-candidate"]').length === 3);
  check(calls.filter(c => c.p.endsWith('/c-pii/approve')).at(-1).body.confirmSensitive === true, 'confirmSensitive sent only after the checkbox');
  // duplicate → warning + explicit override
  await page.locator('[data-testid="mem-candidate"]', { hasText: 'furtif est activé' }).getByTestId('mem-approve-open').click();
  await page.getByTestId('mem-form-submit').click(); await page.getByTestId('mem-allow-duplicate').waitFor();
  check((await page.getByTestId('mem-form-error').innerText()).includes('DUPLICATE_MEMORY'), 'duplicate detected with a warning');
  await page.getByRole('button', { name: 'Annuler' }).click();
  // SNIPPET: explicit type choice
  await page.locator('[data-testid="mem-candidate"]', { hasText: 'extrait de code' }).getByTestId('mem-approve-open').click();
  check((await page.getByTestId('mem-form-type').inputValue()) === 'TECHNICAL_DISCOVERY', 'a SNIPPET candidate gets an explicit memory type');
  await page.getByRole('button', { name: 'Annuler' }).click();
  check((await page.evaluate(() => window.__xssFired)) === undefined && (await page.locator('[data-testid="mem-candidates"] img').count()) === 0, 'no XSS through candidates');

  // ── Manual creation ───────────────────────────────────────────────────────
  await page.getByTestId('mem-tab-new').click(); await page.getByTestId('mem-new-open').click();
  await page.getByTestId('mem-form-statement').fill('x'.repeat(401));
  check(await page.getByTestId('mem-form-submit').isDisabled(), '401 characters: submit disabled (400 max)');
  await page.getByTestId('mem-form-statement').fill('Les exports restent sur le disque local.');
  check(!(await page.getByTestId('mem-form-submit').isDisabled()), 'valid statement enables submit');
  await page.getByTestId('mem-form-type').selectOption('CONSTRAINT'); await page.getByTestId('mem-form-submit').click();
  await page.getByTestId('mem-created').waitFor();
  const man = calls.find(c => c.p.endsWith('/docteur-memory/items') && c.body?.type === 'CONSTRAINT');
  check(man.body.scope.kind === 'PROJECT' && man.body.statement.startsWith('Les exports') && !('approve' in man.body), 'manual memory created explicitly with its scope');
  check((await page.getByTestId('mem-created').innerText()).includes('remplacement(s) possible(s) à confirmer'), 'manual creation reports suggested supersessions (not applied)');

  // ── Ask: « Docteur a utilisé N souvenirs » ────────────────────────────────
  await page.getByTestId('mem-tab-ask').click(); await page.getByTestId('mem-ask-panel').waitFor();
  check((await page.getByTestId('mem-active-project').innerText()).includes('docteur'), 'active project shown (explicit mapping)');
  await page.getByTestId('mem-ask-input').fill('Que fait la recherche ?'); await page.getByTestId('mem-ask').click(); await page.getByTestId('mem-used').waitFor();
  check((await page.getByTestId('mem-used-summary').innerText()).includes('Docteur a utilisé 2 souvenirs'), 'usage summary with the count');
  check(!(await page.getByTestId('mem-used').evaluate(el => el.open)), 'usage list is collapsed by default');
  await page.getByTestId('mem-used-summary').click();
  check((await page.getByTestId('mem-used-item').count()) === 2 && (await page.getByTestId('mem-used').innerText()).includes('HISTORIQUE · SUPERSEDED'), 'expandable list; historical memory labelled');
  check((await page.evaluate(() => window.__xssFired)) === undefined && (await page.getByTestId('mem-answer').innerText()).includes('<img'), 'answer and used statements rendered as text');
  const ask1 = calls.filter(c => c.p.endsWith('/answer')).at(-1);
  check(ask1.body.activeProject === 'docteur' && ask1.body.activeNotebook === 'nb1' && ask1.body.includeHistorical === false, 'answer request carries the explicit project / notebook context');
  await page.getByTestId('mem-historical').check(); await page.getByTestId('mem-search').click();
  check(await until(() => calls.filter(c => c.p.endsWith('/retrieve')).at(-1)?.body.includeHistorical === true), 'historical toggle is sent');
  scenario = 'none'; await page.getByTestId('mem-ask').click();
  await page.waitForFunction(() => /utilisé 0 souvenir/.test(document.querySelector('[data-testid="mem-used-summary"]')?.textContent ?? ''));
  check((await page.getByTestId('mem-used').textContent()).includes('aucune mémoire'), 'no-memory case explained: 0 souvenir, answer relies on no memory');
  scenario = 'conflict'; await page.getByTestId('mem-ask').click(); await page.getByTestId('mem-used-conflict').waitFor({ state: 'attached' });
  check((await page.getByTestId('mem-used-conflict').textContent()).includes('les deux positions'), 'conflict between used memories is surfaced');
  scenario = 'normal';
  // unresolved project: no project memory, explicit notice
  await page.getByTestId('mem-project-select').selectOption('');
  await page.waitForFunction(() => /aucun projet résolu/.test(document.querySelector('[data-testid="mem-active-project"]')?.textContent ?? ''));
  check((await page.getByTestId('mem-active-project').innerText()).includes('aucun projet résolu'), 'unresolved project displayed (never guessed)');
  const nRet = calls.filter(c => c.p.endsWith('/retrieve')).length; await page.getByTestId('mem-search').click();
  check(await until(() => calls.filter(c => c.p.endsWith('/retrieve')).length > nRet) && calls.filter(c => c.p.endsWith('/retrieve')).at(-1).body.activeProject === null, 'no project sent when unresolved');

  // ── Reindex is an explicit action ────────────────────────────────────────────
  scenario = 'reindex'; await page.getByTestId('mem-tab-approved').click(); await page.reload();
  await page.getByText('Mon Notebook', { exact: true }).click(); await page.getByTestId('nb-center-tab-mem').click(); await page.getByTestId('mem-reindex').waitFor();
  check(!calls.some(c => c.p.endsWith('/reindex')), 'no automatic reindexation');
  await page.getByTestId('mem-reindex').click(); await page.waitForFunction(() => document.querySelector('[data-testid="mem-reindex"]') === null);
  check(calls.some(c => c.p.endsWith('/reindex')), 'reindex only on click');

  // ── Layout: no horizontal overflow on a narrow window ───────────────────────
  await page.setViewportSize({ width: 820, height: 800 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'no horizontal page scroll at 820px');
  check(writeTypes.length >= 8 && writeTypes.every(t => t.startsWith('application/json')), `every memory write with a body is application/json (${writeTypes.length} writes)`);
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
  check(!/Device Fabric|furtif|FTS5|Nous avons décidé|Les exports/.test(stored), 'no memory content persisted in localStorage / sessionStorage / cookies');
  check(external.length === 0, `offline: 0 external requests (${external.join(',')})`);
  check(pageErrors.length === 0, `no page error: ${pageErrors.join(' | ')}`);
  console.log(`NB5 browser: ${assertions} assertions OK`);
} catch (e) {
  console.error('NB5 browser FAILED:', e.message); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); await browser?.close(); await server?.close();
}
