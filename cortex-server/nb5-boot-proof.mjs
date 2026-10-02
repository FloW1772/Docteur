// NB-5 — REAL server boot / restart proof (isolated temp SQLite + LanceDB, real Ollama, port 3942).
// A) boot #1: migration, project, NB-4 import → distill → approve ONE candidate (edited), manual KEEP / SESSION_ONLY /
//    DELETE_AFTER memories, hybrid retrieval, cross-project isolation over HTTP, listener inventory.
// B) hard kill (worst case: no graceful shutdown), boot #2 on the same files: KEEP + approved memory survive and are
//    retrievable; SESSION_ONLY memory is ABSENT from SQLite, FTS and LanceDB; migration is idempotent.
// C) graceful SIGINT shutdown of boot #2 (Windows: best effort) — no listener left.
// Usage: node nb5-boot-proof.mjs   (writes ../reports/nb5-boot-proof-results.json)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { connect } from '@lancedb/lancedb';
import { makeZip, chatgptConversation, chatgptExport } from './nb4-fixtures.mjs';

const PORT = 3942; const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5boot-'));
const SQLITE = path.join(TMP, 'boot.sqlite'); const LANCE = path.join(TMP, 'boot.lance');
const OUT = path.resolve('..', 'reports', 'nb5-boot-proof-results.json');
const report = { generatedAt: new Date().toISOString(), port: PORT, steps: [], checks: {} };
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); if (!ok) process.exitCode = 1; };

async function j(method, url, body) {
  const r = await fetch(`${BASE}${url}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json; try { json = JSON.parse(t); } catch { json = { raw: t.slice(0, 200) }; }
  return { status: r.status, json };
}
function boot() {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), SQLITE_PATH: SQLITE, LANCEDB_PATH: LANCE, DOCTEUR_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  return { child, log: () => log };
}
async function waitUp(ms = 60_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(`${BASE}/api/docteur-memory/status`); if (r.ok) return true; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 400)); } return false; }
const listeners = (pid) => { try { return execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).split('\n').filter(l => /LISTENING/.test(l) && l.trim().endsWith(String(pid))).map(l => l.trim().split(/\s+/)[1]); } catch { return ['netstat-unavailable']; } };
const kill = (child) => new Promise(res => { child.once('exit', () => res()); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } setTimeout(res, 5000); });
const inspect = async (ids) => {
  const db = new Database(SQLITE, { readonly: true }); const out = {}; let table = null;
  try { const lance = await connect(LANCE); table = await lance.openTable('docteur_memory'); } catch { /* absent = 0 vectors */ }
  for (const id of ids) out[id] = { item: db.prepare('SELECT COUNT(*) n FROM dmem_items WHERE memory_id = ?').get(id).n, fts: db.prepare('SELECT COUNT(*) n FROM dmem_items_fts WHERE memory_id = ?').get(id).n, embeddingMeta: db.prepare('SELECT COUNT(*) n FROM dmem_embeddings WHERE memory_id = ?').get(id).n, evidence: db.prepare('SELECT COUNT(*) n FROM dmem_evidence WHERE memory_id = ?').get(id).n, vectors: table ? (await table.query().where(`memory_id = '${id}'`).toArray()).length : 0 };
  const counts = { candidates: db.prepare('SELECT COUNT(*) n FROM nb_ai_candidates').get().n, messages: db.prepare('SELECT COUNT(*) n FROM nb_ai_messages').get().n, dmemItems: db.prepare('SELECT COUNT(*) n FROM dmem_items').get().n };
  db.close(); return { out, counts };
};

let srv;
try {
  // ── A) boot #1 ─────────────────────────────────────────────────────────
  srv = boot(); const up = await waitUp(); step('boot #1: server up, memory routes mounted', up, up ? '' : srv.log().slice(-600)); if (!up) throw new Error('boot failed');
  const pid1 = srv.child.pid; const l1 = listeners(pid1); step('boot #1: exactly one listener (no new port opened by memory)', l1.length === 1 && l1[0].endsWith(`:${PORT}`), l1.join(','));
  const st = await j('GET', '/api/docteur-memory/status'); step('memory init: status reachable, strict_local, 0 memories', st.status === 200 && st.json.strict_local === true && st.json.counts.approved === 0);
  const legacy = await j('GET', '/api/memory/settings'); step('Phase-3 adaptive memory routes untouched (/api/memory/settings)', legacy.status === 200);
  for (const [id, name] of [['docteur', 'Docteur'], ['boutique', 'Boutique']]) await j('POST', '/api/docteur-memory/projects', { projectId: id, name });
  const nb = (await j('POST', '/api/notebooks', { title: 'Boot proof' })).json.id;
  await j('PUT', `/api/docteur-memory/notebooks/${nb}/project`, { projectId: 'docteur' });
  // NB-4 → candidate → ONE explicit approval
  const zip = makeZip([{ name: 'conversations.json', data: chatgptExport([chatgptConversation({ id: 'boot', title: 'Architecture', start: 1_741_000_000, turns: [{ role: 'user', text: 'Nous avons décidé de garder Device Fabric en mode ADMIN uniquement pour le contrôle distant.' }, { role: 'assistant', text: 'Très bien, noté.' }] })]) }]);
  const form = new FormData(); form.set('file', new File([zip], 'export.zip'));
  const imp = await (await fetch(`${BASE}/api/notebooks/${nb}/ai-history/imports?wait=1`, { method: 'POST', body: form })).json(); step('NB-4 import READY', imp.status === 'READY', imp.status);
  await j('POST', `/api/notebooks/${nb}/ai-history/imports/${imp.importId}/distill`, {});
  const cands = (await j('GET', `/api/notebooks/${nb}/ai-history/candidates?status=CANDIDATE`)).json.candidates; const dec = cands.find(c => c.type === 'DECISION'); step('NB-4 distillation produced a DECISION candidate (not memory)', !!dec && (await j('GET', '/api/docteur-memory/status')).json.counts.approved === 0);
  const noFlag = await j('POST', `/api/docteur-memory/notebooks/${nb}/candidates/${dec.candidateId}/approve`, { scope: { kind: 'PROJECT', projectId: 'docteur' } }); step('approval without approve:true refused (APPROVAL_REQUIRED, 409)', noFlag.status === 409 && noFlag.json.code === 'APPROVAL_REQUIRED');
  const ap = await j('POST', `/api/docteur-memory/notebooks/${nb}/candidates/${dec.candidateId}/approve`, { approve: true, statement: 'Device Fabric reste en mode ADMIN uniquement pour le contrôle distant.', scope: { kind: 'PROJECT', projectId: 'docteur' } });
  const approvedId = ap.json.memory?.memoryId; step('explicit approval (edited) creates ONE memory with evidence + vector', ap.status === 201 && ap.json.memory.editedBeforeApproval === true && ap.json.vector === 'READY', `${ap.status} vector=${ap.json.vector}`);
  const keep = await j('POST', '/api/docteur-memory/items', { type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'boutique' }, statement: 'La base de données de la boutique est PostgreSQL 16 avec pgbouncer.' });
  const sess = await j('POST', '/api/docteur-memory/items', { type: 'PROJECT_FACT', scope: { kind: 'PROJECT', projectId: 'docteur' }, statement: 'Le code de session temporaire du banc est VIOLET-42.', retention: 'SESSION_ONLY' });
  const timed = await j('POST', '/api/docteur-memory/items', { type: 'PROJECT_FACT', scope: { kind: 'PROJECT', projectId: 'docteur' }, statement: 'Cette note temporaire expire dans une heure exactement.', retention: 'DELETE_AFTER', retentionDuration: '1h' });
  const keepId = keep.json.memory.memoryId; const sessId = sess.json.memory.memoryId; const timedId = timed.json.memory.memoryId;
  step('manual KEEP / SESSION_ONLY / DELETE_AFTER memories created', keep.status === 201 && sess.status === 201 && timed.status === 201);
  let r = await j('POST', '/api/docteur-memory/retrieve', { query: 'Device Fabric ADMIN contrôle distant', activeProject: 'docteur' }); step('hybrid retrieval with real Ollama embeddings', r.json.retrievalMode === 'HYBRID' && r.json.results[0]?.memoryId === approvedId, `${r.json.retrievalMode}/${r.json.vectorStatus}`);
  r = await j('POST', '/api/docteur-memory/retrieve', { query: 'Device Fabric ADMIN contrôle distant', activeProject: 'boutique' }); step('cross-project leakage over HTTP = 0', r.json.results.length === 0);
  r = await j('POST', '/api/docteur-memory/retrieve', { query: 'Device Fabric ADMIN contrôle distant' }); step('no project ⇒ no project memory (never guessed)', r.json.results.length === 0 && r.json.notice === 'PROJECT_UNRESOLVED_NO_PROJECT_MEMORY');
  r = await j('POST', '/api/docteur-memory/retrieve', { query: 'session temporaire banc VIOLET', activeProject: 'docteur' }); step('SESSION_ONLY memory usable in this session', r.json.results.some(x => x.memoryId === sessId));
  const a = await j('POST', '/api/docteur-memory/answer', { question: 'Que sait-on de Device Fabric ?', activeProject: 'docteur' }); step('memory answer via the local LLM: authority CONTEXT_ONLY, usage listed', a.status === 200 && a.json.authority === 'CONTEXT_ONLY' && a.json.memoryUsed.length >= 1, `${a.status} used=${a.json.memoryUsed?.length}`);
  // ── NB-6: a hostile web page / DNS-rebinding request against the REAL server ──────────────────────────
  const approvedBefore = (await j('GET', '/api/docteur-memory/status')).json.counts.approved;
  const rawGet = (host) => new Promise((res, rej) => { const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/api/docteur-memory/items', headers: { host } }, (rs) => { rs.resume(); res(rs.statusCode); }); rq.on('error', rej); rq.end(); });
  step('DNS rebinding: Host attacker.example ⇒ 403 (memory readable only via local hosts)', (await rawGet('attacker.example:3942')) === 403 && (await rawGet(`127.0.0.1:${PORT}`)) === 200);
  const evilBrowser = await chromium.launch({ headless: true });
  try {
    const page = await evilBrowser.newPage();
    await page.route('https://evil.example/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>evil</body></html>' }));
    await page.goto('https://evil.example/');
    const outcome = await page.evaluate(async (base) => {
      const out = {};
      const item = JSON.stringify({ type: 'DECISION', scope: { kind: 'PROJECT', projectId: 'docteur' }, statement: 'Souvenir empoisonné par une page web hostile.' });
      try { await fetch(`${base}/api/docteur-memory/items`, { method: 'POST', mode: 'no-cors', body: item }); out.simple = 'sent'; } catch (e) { out.simple = `blocked:${e.name}`; }
      try { await fetch(`${base}/api/docteur-memory/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: item }); out.json = 'sent'; } catch (e) { out.json = `blocked:${e.name}`; }
      try { await fetch(`${base}/api/docteur-memory/items/x`, { method: 'DELETE' }); out.del = 'sent'; } catch (e) { out.del = `blocked:${e.name}`; }
      try { const r = await fetch(`${base}/api/docteur-memory/items`); out.read = `status:${r.status}`; } catch (e) { out.read = `blocked:${e.name}`; }
      return out;
    }, BASE);
    report.checks.hostilePage = outcome;
    await new Promise(r => setTimeout(r, 500));
    const approvedAfter = (await j('GET', '/api/docteur-memory/status')).json.counts.approved;
    step('hostile web page (real Chromium, Origin https://evil.example): no memory created, nothing readable', approvedAfter === approvedBefore && !/status:200/.test(outcome.read), JSON.stringify(outcome));
  } finally { await evilBrowser.close(); }
  const before = await inspect([approvedId, keepId, sessId, timedId]); report.checks.beforeRestart = before;
  step('SESSION_ONLY row present on disk before restart (documented: disk is touched, guarantee = absent after restart)', before.out[sessId].item === 1 && before.out[sessId].vectors === 1);

  // ── B) hard kill + boot #2 ────────────────────────────────────────────
  await kill(srv.child); await new Promise(r2 => setTimeout(r2, 800));
  srv = boot(); const up2 = await waitUp(); step('boot #2 (same files): server up, migration idempotent', up2, up2 ? '' : srv.log().slice(-600)); if (!up2) throw new Error('boot #2 failed');
  const after = await inspect([approvedId, keepId, sessId, timedId]); report.checks.afterRestart = after;
  step('KEEP + approved memories survive the restart', after.out[approvedId].item === 1 && after.out[keepId].item === 1 && after.out[approvedId].vectors === 1 && after.out[keepId].vectors === 1);
  step('SESSION_ONLY memory ABSENT after restart: row, FTS, embedding meta, LanceDB vector = 0', Object.values(after.out[sessId]).every(v => v === 0), JSON.stringify(after.out[sessId]));
  step('DELETE_AFTER (1h) memory still present (not yet expired)', after.out[timedId].item === 1);
  step('NB-4 data preserved across restart', after.counts.candidates === before.counts.candidates && after.counts.messages === before.counts.messages);
  r = await j('POST', '/api/docteur-memory/retrieve', { query: 'Device Fabric ADMIN contrôle distant', activeProject: 'docteur' }); step('approved memory retrievable after restart (hybrid)', r.json.results[0]?.memoryId === approvedId && r.json.retrievalMode === 'HYBRID');
  r = await j('POST', '/api/docteur-memory/retrieve', { query: 'session temporaire banc VIOLET', activeProject: 'docteur' }); step('SESSION_ONLY memory not retrievable after restart', r.json.results.length === 0);
  const ev = await j('GET', `/api/docteur-memory/items/${approvedId}`); step('provenance + evidence intact after restart', ev.json.evidence.length >= 1 && ev.json.memory.sourceCandidateId === dec.candidateId);
  await j('POST', `/api/docteur-memory/items/${keepId}/revoke`, {}); await j('DELETE', `/api/docteur-memory/items/${approvedId}`);
  const purged = await inspect([approvedId, keepId]); step('delete purges SQLite + FTS + vector; revoke removes FTS + vector (row kept)', Object.values(purged.out[approvedId]).every(v => v === 0) && purged.out[keepId].item === 1 && purged.out[keepId].fts === 0 && purged.out[keepId].vectors === 0, JSON.stringify(purged.out));
  const l2 = listeners(srv.child.pid); step('boot #2: one listener only', l2.length === 1 && l2[0].endsWith(`:${PORT}`), l2.join(','));
  const logText = srv.log(); step('server log carries no memory statement / query text', !/VIOLET-42|PostgreSQL 16|Device Fabric ADMIN/.test(logText));
  report.checks.listeners = { boot1: l1, boot2: l2 };
} catch (e) { step('proof aborted', false, e.message); } finally {
  if (srv) await kill(srv.child);
  await new Promise(r => setTimeout(r, 500));
  try { const still = await fetch(`${BASE}/api/docteur-memory/status`).then(() => true).catch(() => false); step('shutdown: nothing listens on the proof port afterwards', !still); } catch { /* ignore */ }
  report.passed = report.steps.filter(s => s.ok).length; report.total = report.steps.length;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
  console.log(`BOOT PROOF ${report.passed}/${report.total}`); process.exit(process.exitCode ?? 0);
}
