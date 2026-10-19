// [COMPANION-STATUS-PROJECTION-REMED-1] The public /companion/status activation must follow the certified boot decision.
// Uses the exact activation expression from src/server.js, the real boot gate, the real UI service and the real route,
// on isolated production-like stores below cortex-server/data/ (never the real Companion store). NB-5 is an inert port:
// the status path must never reach it.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CompanionMemory, NB5_PORT } from './src/lib/companion-memory.js';
import { createCompanionActions } from './src/lib/companion-actions.js';
import { createCompanionUiService } from './src/lib/companion-ui-service.js';
import { createCompanionUiRoute } from './src/routes/companion.js';
import { COMPANION_ACTIVATION, COMPANION_ACTIVE, activateCompanion, deactivateCompanion, ensureCompanionProductionStore, openCompanionAtBoot } from './src/lib/companion-boot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const REAL_STORE = path.join(DATA, 'companion-v1', 'companion.sqlite');
const SERVER_SRC = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');

// The product projection, read from server.js itself so the test follows the shipped expression.
const PROJECTION_SRC = (() => {
  const m = SERVER_SRC.match(/createCompanionUiService\(\{[^}]*\bactivation:\s*([^}]+?)\s*\}\)/);
  assert.ok(m, 'server.js wires createCompanionUiService with an activation argument');
  return m[1];
})();
assert.match(PROJECTION_SRC, /^[\w$?.\s]+$/, 'the projection is a plain expression over identifiers');
const project = new Function('companionBootDecision', 'COMPANION_ACTIVATION', `return (${PROJECTION_SRC});`);

const inertNb5 = Object.fromEntries(NB5_PORT.map(fn => [fn, () => { throw new Error(`NB-5 ${fn} must not be used by status`); }]));

/** Mirrors the server.js Companion block: boot → (store ? service : null) → route. */
function bootProduct(env) {
  const { store, decision } = openCompanionAtBoot({ env });
  let service = null;
  if (store) {
    const companion = new CompanionMemory({ store, nb5: inertNb5 });
    const actions = createCompanionActions({ store, companion });
    service = createCompanionUiService({ actions, companion, store, activation: project(decision, COMPANION_ACTIVATION) });
  }
  const app = createCompanionUiRoute({ service, disabledReason: decision.reason });
  return { store, decision, app };
}

async function getStatus(app) {
  const res = await app.request('/companion/status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.value;
}

function productionLikeRoot() {
  const root = fs.mkdtempSync(path.join(DATA, '.test-companion-status-'));
  const env = { SQLITE_PATH: path.relative(HERE, path.join(root, 'cortex.sqlite')) };
  const dbPath = path.join(root, 'companion-v1', 'companion.sqlite');
  assert.notEqual(path.resolve(dbPath), REAL_STORE, 'never the real Companion store');
  return { root, env, dbPath };
}

function futureFixture(dbPath, { version, versionType = 'INTEGER' }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE companion_schema_migrations(version ${versionType} PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE companion_installation(singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL, profile TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO companion_installation VALUES(1, 'fixture', 'LOCAL_SINGLE_USER', '2026-10-18T00:00:00.000Z');
    CREATE TABLE companion_activation(singleton INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO companion_activation VALUES(1, 'ACTIVE', '2026-10-18T00:00:00.000Z');`);
  db.prepare('INSERT INTO companion_schema_migrations VALUES (?, ?, ?)').run(version, 'fixture', '2026-10-18T00:00:00.000Z');
  db.close();
}

test('ACTIVE boot → public status ACTIVE; disabled boot → status disabled; capability exposure agrees with both', async () => {
  const prod = productionLikeRoot();
  try {
    assert.equal(ensureCompanionProductionStore({ env: prod.env }).activation.state, COMPANION_ACTIVATION);

    // 1: persisted ACTIVE (official isolated activation) → boot ACTIVE → status ACTIVE, capabilities exposed.
    assert.equal(activateCompanion({ env: prod.env }).state, COMPANION_ACTIVE);
    const active = bootProduct(prod.env);
    try {
      assert.ok(active.store);
      assert.equal(active.decision.activation.state, COMPANION_ACTIVE);
      const status = await getStatus(active.app);
      assert.equal(status.activation, COMPANION_ACTIVE, 'boot ACTIVE ⇒ public status ACTIVE (no boot/status disagreement)');
      assert.equal(status.schemaVersion, 4);
      assert.deepEqual(Object.keys(status).sort(), ['activation', 'model', 'preferences', 'schemaVersion'], 'status exposes no KG / COMP-7 field');
      const session = await active.app.request('/companion/sessions', { method: 'POST' });
      assert.equal(session.status, 200, 'ACTIVE exposes the gesture capability');
    } finally { active.store?.close(); }

    // 2: persisted DISABLED (official deactivation) → boot disabled → status disabled, capabilities refused.
    assert.equal(deactivateCompanion({ env: prod.env }).state, COMPANION_ACTIVATION);
    const disabled = bootProduct(prod.env);
    assert.equal(disabled.store, null);
    assert.equal(disabled.decision.reason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
    const status = await getStatus(disabled.app);
    assert.equal(status.activation, COMPANION_ACTIVATION);
    assert.equal(status.disabledReason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
    const refused = await disabled.app.request('/companion/sessions', { method: 'POST' });
    assert.equal((await refused.json()).error.code, 'COMPANION_DISABLED', 'disabled exposes no capability');

    // 5: KG inactive in the store.
    const inspect = new Database(prod.dbPath, { readonly: true, fileMustExist: true });
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'kg_%'").pluck().get(), 0);
    inspect.close();
  } finally {
    fs.rmSync(prod.root, { recursive: true, force: true });
  }
});

test('future or malformed production store → boot fails closed and status never claims ACTIVE', async () => {
  for (const fixture of [{ version: 999 }, { version: 'unknown', versionType: 'TEXT' }]) {
    const prod = productionLikeRoot();
    try {
      futureFixture(prod.dbPath, fixture);
      const booted = bootProduct(prod.env);
      assert.equal(booted.store, null);
      assert.equal(booted.decision.reason, 'COMPANION_PRODUCTION_STORE_FAILED');
      const status = await getStatus(booted.app);
      assert.notEqual(status.activation, COMPANION_ACTIVE, `${fixture.version}: never ACTIVE`);
      assert.equal(status.activation, COMPANION_ACTIVATION);
      assert.equal(status.disabledReason, 'COMPANION_PRODUCTION_STORE_FAILED');
    } finally {
      fs.rmSync(prod.root, { recursive: true, force: true });
    }
  }
});

test('projection falls back to the safe constant when no boot activation state is resolved; KG / model only through the COMP-7 wiring', () => {
  assert.equal(project({}, COMPANION_ACTIVATION), COMPANION_ACTIVATION);
  assert.equal(project({ enabled: false, reason: 'COMPANION_UI_WIRING_FAILED' }, COMPANION_ACTIVATION), COMPANION_ACTIVATION);
  assert.equal(project({ activation: null }, COMPANION_ACTIVATION), COMPANION_ACTIVATION);
  assert.equal(project({ activation: { state: COMPANION_ACTIVATION } }, COMPANION_ACTIVATION), COMPANION_ACTIVATION);
  assert.equal(project({ activation: { state: COMPANION_ACTIVE } }, COMPANION_ACTIVATION), COMPANION_ACTIVE);
  const block = SERVER_SRC.slice(SERVER_SRC.indexOf('[Companion V1 COMP-6B]'), SERVER_SRC.indexOf('const shutdownCompanion')).replace(/\/\/.*$/gm, '');
  assert.ok(block.length > 0);
  // [COMP-7 PRODUCT WIRING] (was: no KG / model / COMP-7 at all) — the block reaches the KG and the local model only
  // through one wireCompanionConversation call; it never creates a model, a KG API / store, or a worker itself.
  assert.equal(/KnowledgeGraph|createCompanionModel|createCompanionKgReadPort|worker/i.test(block), false, 'no direct KG API / model / worker in the Companion block');
  assert.equal(block.split('wireCompanionConversation(').length - 1, 1, 'one COMP-7 wiring call');
  assert.deepEqual([...new Set(block.match(/\w*kg\w*/gi) ?? [])].sort(), ['kgContext', 'kgGate', 'kgStore'], 'KG identifiers limited to the wiring hand-off');
});
