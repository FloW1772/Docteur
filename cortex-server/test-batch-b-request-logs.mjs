// BATCH B — request_logs retention/purge strategy (autorisé 2026-09-16).
//
// request_logs est écrit à CHAQUE requête HTTP (middleware global dans
// server.js) et n'est jamais lu par aucune route — 67 327 lignes en
// production au moment de l'audit Phase 9, sans index, sans purge. La
// stratégie : rétention configurable (défaut 30 jours), purge par petits
// batchs bornés (jamais un DELETE global) exécutée une fois au boot, comme
// le fait déjà purgeActivityLogOlderThan pour activity_log — sauf que
// request_logs peut grossir bien plus vite, donc le batching est obligatoire
// ici (voir commentaire sur purgeRequestLogsOlderThan dans lib/sqlite.js).
//
// DB synthétique en mémoire uniquement — jamais la base réelle.
// Run: node --test test-batch-b-request-logs.mjs
import './test-setup.mjs';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initSqlite,
  logRequest,
  getRequestLogRetentionDays,
  setRequestLogRetentionDays,
  getRequestLogStats,
  purgeRequestLogsOlderThan,
} from './src/lib/sqlite.js';

const db = initSqlite(':memory:');

function insertLogAt(daysAgo, endpoint = '/api/test') {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO request_logs (timestamp, endpoint, latency_ms, model_used, payload_size, status_code, ok, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ts, endpoint, 10, null, 0, 200, 1, null);
}

function clearRequestLogs() {
  db.prepare('DELETE FROM request_logs').run();
}

beforeEach(() => {
  clearRequestLogs();
});

// ── Retention config ─────────────────────────────────────────────────────

test('getRequestLogRetentionDays: defaults to 30 when never configured', () => {
  // Fresh key namespace per test run via :memory: DB — no prior setMeta call yet.
  assert.equal(getRequestLogRetentionDays(), 30);
});

test('setRequestLogRetentionDays: clamps to [1, 365]', () => {
  assert.equal(setRequestLogRetentionDays(45), 45);
  assert.equal(getRequestLogRetentionDays(), 45);
  // 0 is falsy under the `Number(days) || 30` guard (same convention as
  // setActivityLogRetentionDays) so it falls back to the default, not to 1.
  assert.equal(setRequestLogRetentionDays(0), 30);
  assert.equal(setRequestLogRetentionDays(-10), 1);
  assert.equal(setRequestLogRetentionDays(10000), 365);
  assert.equal(setRequestLogRetentionDays(NaN), 30); // falls back to default, not 0/NaN
});

// ── Core purge behaviour ─────────────────────────────────────────────────

test('purgeRequestLogsOlderThan: old logs deleted, recent logs preserved', () => {
  insertLogAt(60, '/api/old-1');
  insertLogAt(45, '/api/old-2');
  insertLogAt(10, '/api/recent-1');
  insertLogAt(1, '/api/recent-2');

  const deleted = purgeRequestLogsOlderThan(30);
  assert.equal(deleted, 2);

  const remaining = db.prepare('SELECT endpoint FROM request_logs ORDER BY endpoint').all().map(r => r.endpoint);
  assert.deepEqual(remaining, ['/api/recent-1', '/api/recent-2']);
});

test('purgeRequestLogsOlderThan: nothing eligible → 0 deleted, table untouched', () => {
  insertLogAt(1);
  insertLogAt(5);

  const deleted = purgeRequestLogsOlderThan(30);
  assert.equal(deleted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n, 2);
});

test('purgeRequestLogsOlderThan: empty table → 0 deleted, no crash', () => {
  const deleted = purgeRequestLogsOlderThan(30);
  assert.equal(deleted, 0);
});

test('purgeRequestLogsOlderThan: invalid/non-numeric days falls back safely (Number(NaN) days = cutoff is Invalid Date, matches nothing eligible under "<")', () => {
  insertLogAt(9999); // absurdly old
  // Number('not-a-number') is NaN → cutoff Date is Invalid Date → its ISO
  // string comparison never satisfies timestamp < cutoff, so this must
  // purge NOTHING rather than throw or wipe the table.
  assert.doesNotThrow(() => purgeRequestLogsOlderThan('not-a-number'));
  const deleted = purgeRequestLogsOlderThan('not-a-number');
  assert.equal(deleted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n, 1);
});

// ── Batch size is respected (no unbounded DELETE) ────────────────────────

test('purgeRequestLogsOlderThan: respects batchSize — one batch deletes at most batchSize rows', () => {
  for (let i = 0; i < 25; i++) insertLogAt(60, `/api/old-${i}`);

  const deleted = purgeRequestLogsOlderThan(30, { batchSize: 10, maxBatches: 1 });
  assert.equal(deleted, 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n, 15);
});

test('purgeRequestLogsOlderThan: multiple batches accumulate up to maxBatches, then stop even if more remain', () => {
  for (let i = 0; i < 55; i++) insertLogAt(60, `/api/old-${i}`);

  const deleted = purgeRequestLogsOlderThan(30, { batchSize: 10, maxBatches: 3 });
  assert.equal(deleted, 30); // 3 batches * 10 — stops even though 25 more are eligible
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n, 25);
});

test('purgeRequestLogsOlderThan: stops early once a batch returns fewer than batchSize rows (no wasted empty batches)', () => {
  for (let i = 0; i < 12; i++) insertLogAt(60, `/api/old-${i}`);

  const deleted = purgeRequestLogsOlderThan(30, { batchSize: 10, maxBatches: 20 });
  assert.equal(deleted, 12); // batch 1: 10 rows, batch 2: 2 rows (< batchSize) → stop, no batch 3
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n, 0);
});

// ── Synthetic large volume ───────────────────────────────────────────────

test('purgeRequestLogsOlderThan: large synthetic volume (2000 old + 500 recent) purges only the old rows across several bounded batches', () => {
  for (let i = 0; i < 2000; i++) insertLogAt(90, `/api/bulk-old-${i}`);
  for (let i = 0; i < 500; i++) insertLogAt(2, `/api/bulk-recent-${i}`);

  const deleted = purgeRequestLogsOlderThan(30, { batchSize: 500, maxBatches: 10 });
  assert.equal(deleted, 2000);

  const remainingCount = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n;
  assert.equal(remainingCount, 500);

  const stillOld = db.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE endpoint LIKE '/api/bulk-old-%'").get().n;
  assert.equal(stillOld, 0);
});

// ── Stats ─────────────────────────────────────────────────────────────────

test('getRequestLogStats: reports count and retentionDays consistent with table state', () => {
  insertLogAt(1);
  insertLogAt(2);
  insertLogAt(3);
  setRequestLogRetentionDays(30);

  const stats = getRequestLogStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.retentionDays, 30);
  assert.equal(typeof stats.sizeBytes, 'number');
  assert.ok(stats.sizeBytes >= 0);
});

test('logRequest: still writes rows normally after purge functions are introduced (no regression to existing write path)', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n;
  logRequest({ endpoint: '/api/smoke', latencyMs: 12.7, statusCode: 200, ok: true });
  const after = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n;
  assert.equal(after, before + 1);

  const row = db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.endpoint, '/api/smoke');
  assert.equal(row.latency_ms, 13); // Math.round(12.7)
  assert.equal(row.ok, 1);
});
