// DEVICE FABRIC Phase 3 — fabric_audit migration from the Phase 2 schema.
// A Phase 2 database already has fabric_audit with the smaller event enum;
// initSqlite must rebuild it once, keep every row, and still reject events
// outside the closed enum. Nothing outside fabric_* is touched.
// Run with: node --test test-device-fabric-migration.mjs
import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDatabase, initSqlite, insertFabricAudit, listFabricAudit } from './src/lib/sqlite.js';

const TEST_ROOT = './data-test-device-fabric-migration';
const DB_PATH = `${TEST_ROOT}/phase2.db`;

before(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const phase2 = new Database(DB_PATH);
  phase2.exec(`
    CREATE TABLE fabric_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'FABRIC_DEVICE_CREATED', 'FABRIC_DEVICE_RENAMED', 'FABRIC_DEVICE_REMOVED',
        'FABRIC_AGENT_LINKED', 'FABRIC_AGENT_UNLINKED', 'FABRIC_LINK_REJECTED')),
      fabric_device_id TEXT,
      agent_type TEXT CHECK (agent_type IS NULL OR agent_type IN ('OMEGA', 'RASSILON')),
      agent_device_id TEXT,
      reason TEXT CHECK (reason IS NULL OR length(reason) <= 64)
    );
    CREATE TABLE unrelated_marker (value TEXT);
    INSERT INTO unrelated_marker VALUES ('untouched');
  `);
  const insert = phase2.prepare('INSERT INTO fabric_audit (created_at, event_type, fabric_device_id, agent_type, agent_device_id, reason) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('2026-09-24T10:00:00.000Z', 'FABRIC_DEVICE_CREATED', 'fdev-old', null, null, null);
  insert.run('2026-09-24T10:01:00.000Z', 'FABRIC_LINK_REJECTED', 'fdev-old', 'RASSILON', 'rassilon-old', 'cross_agent_key_reuse');
  phase2.close();
  initSqlite(DB_PATH);
});

test('Phase 2 fabric_audit is migrated in place: rows kept, ids kept, new columns present', () => {
  const rows = listFabricAudit({ limit: 10 });
  assert.deepEqual(rows.map(r => [r.id, r.eventType, r.reason]).sort((a, b) => a[0] - b[0]), [
    [1, 'FABRIC_DEVICE_CREATED', null], [2, 'FABRIC_LINK_REJECTED', 'cross_agent_key_reuse'],
  ]);
  const columns = getDatabase().prepare('PRAGMA table_info(fabric_audit)').all().map(c => c.name);
  assert.ok(columns.includes('operation_id') && columns.includes('correlation_id'));
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'fabric_audit_v3'").get().c, 0);
  assert.equal(getDatabase().prepare('SELECT value FROM unrelated_marker').get().value, 'untouched');
});

test('migrated table accepts the Phase 3 route events and still rejects anything outside the enum', () => {
  insertFabricAudit({ eventType: 'FABRIC_ROUTE_REQUESTED', fabricDeviceId: 'fdev-old', agentType: 'RASSILON', operationId: 'fop-x', correlationId: 'fcor-x' });
  const latest = listFabricAudit({ limit: 1 })[0];
  assert.equal(latest.eventType, 'FABRIC_ROUTE_REQUESTED');
  assert.equal(latest.correlationId, 'fcor-x');
  assert.throws(() => insertFabricAudit({ eventType: 'FABRIC_EXECUTE' }), /CHECK/);
  assert.equal(latest.id, 3, 'AUTOINCREMENT continues after the migrated rows');
});
