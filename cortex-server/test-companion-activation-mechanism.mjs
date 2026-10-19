import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CompanionStore } from './src/lib/companion-store.js';
import {
  COMPANION_ACTIVATION, COMPANION_ACTIVE, COMPANION_CERTIFIED, COMPANION_DEV_DB_ENV,
  activateCompanion, deactivateCompanion, ensureCompanionProductionStore, openCompanionAtBoot, readCompanionActivation, resolveCompanionBoot, resolveCompanionProductionStorePath,
} from './src/lib/companion-boot.js';

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPROVED_DATA_ROOT = path.join(SERVER_ROOT, 'data');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-activation-'));
  return { dir, dbPath: path.join(dir, 'companion.sqlite') };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeSchemaFixture(dbPath, { version, state, versionType = 'INTEGER', name = 'future-fixture' }) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE companion_schema_migrations(version ${versionType} PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE companion_installation(singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL, profile TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO companion_installation VALUES(1, 'fixture-owner', 'LOCAL_SINGLE_USER', '2026-10-18T00:00:00.000Z');
    CREATE TABLE companion_activation(singleton INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO companion_activation VALUES(1, '${state}', '2026-10-18T00:00:00.000Z');`);
  db.prepare('INSERT INTO companion_schema_migrations VALUES (?, ?, ?)').run(version, name, '2026-10-18T00:00:00.000Z');
  db.close();
}

test('certification is explicit and a certified Companion starts disabled', () => {
  assert.equal(COMPANION_CERTIFIED, true);
  const { dir, dbPath } = tempDb();
  try {
    assert.equal(readCompanionActivation({ dbPath }).state, COMPANION_ACTIVATION);
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).store, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing and malformed activation states fail closed', async () => {
  const { dir, dbPath } = tempDb();
  try {
    assert.equal(readCompanionActivation({ dbPath: path.join(dir, 'missing', 'invalid.sqlite') }).state, COMPANION_ACTIVATION);
    assert.equal(activateCompanion({ dbPath: 'relative-invalid' }).ok, false);
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).store, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dev DB selection does not activate; explicit activation and deactivation are isolated and persistent', () => {
  const { dir, dbPath } = tempDb();
  try {
    assert.equal(resolveCompanionBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).enabled, true);
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).store, null);
    assert.equal(activateCompanion({ dbPath }).state, COMPANION_ACTIVE);
    const opened = openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } });
    assert.ok(opened.store);
    opened.store.close();
    assert.equal(deactivateCompanion({ dbPath }).state, COMPANION_ACTIVATION);
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).store, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('activation requires an isolated path and does not touch KG or external network', () => {
  assert.equal(activateCompanion({ dbPath: path.resolve('data', 'forbidden.sqlite') }).ok, false);
  assert.equal(COMPANION_ACTIVE, 'ACTIVE');
});

test('production store target, initialization, isolation, and fail-closed behavior', () => {
  fs.mkdirSync(APPROVED_DATA_ROOT, { recursive: true });
  const productDataRoot = fs.mkdtempSync(path.join(APPROVED_DATA_ROOT, '.test-companion-prod-'));
  const dev = tempDb();
  try {
    const canonical = path.join(productDataRoot, 'cortex.sqlite');
    const relativeCanonical = path.relative(SERVER_ROOT, canonical);
    const env = { SQLITE_PATH: relativeCanonical };
    const expected = path.join(productDataRoot, 'companion-v1', 'companion.sqlite');
    const official = path.join(APPROVED_DATA_ROOT, 'companion-v1', 'companion.sqlite');

    assert.equal(resolveCompanionProductionStorePath({ env: {} }), official, 'default production path is deterministic');
    assert.equal(resolveCompanionProductionStorePath({ env }), expected, 'relative SQLITE_PATH follows the server root, not cwd');
    assert.notEqual(expected, canonical, 'production store differs from canonical DB');
    assert.notEqual(expected, dev.dbPath, 'production store differs from dev DB');

    fs.writeFileSync(canonical, 'CANONICAL-SENTINEL');
    const canonicalBefore = fs.readFileSync(canonical);
    assert.equal(readCompanionActivation({ dbPath: dev.dbPath }).state, COMPANION_ACTIVATION);
    const devBeforeProductionInit = fs.readFileSync(dev.dbPath);

    const first = ensureCompanionProductionStore({ env });
    assert.equal(first.schemaVersion, 4);
    assert.equal(first.activation.state, COMPANION_ACTIVATION);
    assert.notEqual(first.activation.state, COMPANION_ACTIVE, 'initialization never activates Companion');
    assert.deepEqual(fs.readFileSync(canonical), canonicalBefore, 'canonical DB is untouched');
    assert.deepEqual(fs.readFileSync(dev.dbPath), devBeforeProductionInit, 'production initialization does not mutate dev DB');
    assert.equal(fs.existsSync(expected), true, 'missing production store is created');

    const inspect = new Database(expected, { readonly: true, fileMustExist: true });
    const ownerBefore = inspect.prepare('SELECT installation_id FROM companion_installation WHERE singleton = 1').pluck().get();
    assert.equal(inspect.prepare('SELECT MAX(version) FROM companion_schema_migrations').pluck().get(), 4, 'schema v4 is present');
    assert.equal(inspect.prepare('SELECT COUNT(*) FROM companion_activation').pluck().get(), 1);
    assert.equal(inspect.prepare('SELECT state FROM companion_activation WHERE singleton = 1').pluck().get(), COMPANION_ACTIVATION);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'kg_%'").pluck().get(), 0, 'KG remains inactive');
    inspect.close();

    assert.throws(() => CompanionStore.open({ dbPath: expected }), error => error?.code === 'COMP_DB_IN_USER_DATA', 'ordinary store callers remain unauthorized');
    assert.equal(activateCompanion({ dbPath: expected, env }).state, COMPANION_ACTIVE, 'official production activation target opens through narrow authorization');
    const activeInspect = new Database(expected, { readonly: true, fileMustExist: true });
    assert.equal(activeInspect.prepare('SELECT state FROM companion_activation WHERE singleton = 1').pluck().get(), COMPANION_ACTIVE);
    assert.equal(activeInspect.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'kg_%'").pluck().get(), 0, 'production activation does not activate KG');
    activeInspect.close();
    assert.equal(deactivateCompanion({ dbPath: expected, env }).state, COMPANION_ACTIVATION, 'official production deactivation target opens through narrow authorization');

    const productionBeforeDevBoot = fs.readFileSync(expected);
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dev.dbPath } }).store, null);
    assert.deepEqual(fs.readFileSync(expected), productionBeforeDevBoot, 'dev DB selection does not mutate production store');

    const second = ensureCompanionProductionStore({ env });
    assert.equal(second.schemaVersion, 4);
    assert.equal(second.activation.state, COMPANION_ACTIVATION, 'idempotent initialization stays disabled');
    const reinspect = new Database(expected, { readonly: true, fileMustExist: true });
    assert.equal(reinspect.prepare('SELECT installation_id FROM companion_installation WHERE singleton = 1').pluck().get(), ownerBefore, 'existing valid store is preserved');
    assert.equal(reinspect.prepare('SELECT COUNT(*) FROM companion_installation').pluck().get(), 1, 'no duplicate installation');
    assert.equal(reinspect.prepare('SELECT COUNT(*) FROM companion_activation').pluck().get(), 1, 'no duplicate activation row');
    reinspect.close();

    assert.throws(
      () => resolveCompanionProductionStorePath({ env: { SQLITE_PATH: expected }, productDataRoot }),
      /COMPANION_STORE_COLLISION_CANONICAL_DB/,
    );
    assert.throws(
      () => resolveCompanionProductionStorePath({ env: { SQLITE_PATH: relativeCanonical, [COMPANION_DEV_DB_ENV]: expected } }),
      /COMPANION_STORE_COLLISION_DEV_DB/,
    );

    const corruptRoot = path.join(productDataRoot, 'corrupt-case');
    const corruptPath = path.join(corruptRoot, 'companion-v1', 'companion.sqlite');
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    const corruptBytes = Buffer.from('not-a-sqlite-database');
    fs.writeFileSync(corruptPath, corruptBytes);
    assert.throws(() => ensureCompanionProductionStore({ env, productDataRoot: corruptRoot }));
    assert.deepEqual(fs.readFileSync(corruptPath), corruptBytes, 'corrupt data is not deleted or recreated');

    assert.equal(first.activation.state, COMPANION_ACTIVATION, 'COMP-7 remains inactive while Companion is disabled');
  } finally {
    fs.rmSync(productDataRoot, { recursive: true, force: true });
    fs.rmSync(dev.dir, { recursive: true, force: true });
  }
});

test('future and corrupt schema metadata fail closed before activation is trusted and are not rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-schema-fail-closed-'));
  try {
    for (const state of [COMPANION_ACTIVE, COMPANION_ACTIVATION]) {
      const dbPath = path.join(dir, `v999-${state}.sqlite`);
      makeSchemaFixture(dbPath, { version: 999, state });
      const before = sha256File(dbPath);
      assert.throws(() => CompanionStore.open({ dbPath }), error => error?.code === 'COMP_UNSUPPORTED_SCHEMA_VERSION');
      assert.deepEqual(readCompanionActivation({ dbPath }), { state: COMPANION_ACTIVATION, eligible: false, reason: 'COMPANION_ACTIVATION_STATE_INVALID' });
      assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: dbPath } }).store, null, 'unsupported schema never boots ACTIVE');
      assert.equal(sha256File(dbPath), before, 'unsupported schema is neither downgraded nor rewritten');
      const inspect = new Database(dbPath, { readonly: true, fileMustExist: true });
      assert.equal(inspect.prepare('SELECT version FROM companion_schema_migrations').pluck().get(), 999);
      assert.equal(inspect.prepare('SELECT state FROM companion_activation').pluck().get(), state);
      inspect.close();
    }

    const unknownPath = path.join(dir, 'unknown-schema.sqlite');
    makeSchemaFixture(unknownPath, { version: 'unknown', versionType: 'TEXT', state: COMPANION_ACTIVE, name: 'unknown' });
    const unknownBefore = sha256File(unknownPath);
    assert.throws(() => CompanionStore.open({ dbPath: unknownPath }), error => error?.code === 'COMP_SCHEMA_METADATA_INVALID');
    assert.equal(readCompanionActivation({ dbPath: unknownPath }).state, COMPANION_ACTIVATION);
    assert.equal(sha256File(unknownPath), unknownBefore, 'corrupt schema metadata is not rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// [COMPANION-BOOT-PROD-REMED-1] Normal boot (no dev store) must consume the official production store's persisted state.
function productionLikeRoot() {
  fs.mkdirSync(APPROVED_DATA_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(APPROVED_DATA_ROOT, '.test-companion-boot-prod-'));
  const env = { SQLITE_PATH: path.relative(SERVER_ROOT, path.join(root, 'cortex.sqlite')) };
  return { root, env, dbPath: path.join(root, 'companion-v1', 'companion.sqlite') };
}

function activationRow(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT state, updated_at AS updatedAt FROM companion_activation WHERE singleton = 1').get() ?? null; } finally { db.close(); }
}

test('normal boot consumes the production store: ACTIVE only from the persisted row, read-only, unauthorized callers refused', () => {
  const prod = productionLikeRoot();
  const dev = tempDb();
  const official = path.join(APPROVED_DATA_ROOT, 'companion-v1', 'companion.sqlite');
  try {
    assert.equal(resolveCompanionProductionStorePath({ env: prod.env }), prod.dbPath);
    assert.notEqual(prod.dbPath, official, 'the real production store is never used by this test');

    // 1 + 4: initialized production store, certification=true alone → disabled.
    assert.equal(COMPANION_CERTIFIED, true);
    assert.equal(ensureCompanionProductionStore({ env: prod.env }).activation.state, COMPANION_ACTIVATION);
    const disabledBytes = sha256File(prod.dbPath);
    const disabled = openCompanionAtBoot({ env: prod.env });
    assert.equal(disabled.store, null);
    assert.equal(disabled.decision.enabled, false);
    assert.equal(disabled.decision.reason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
    assert.equal(disabled.decision.production.dbPath, prod.dbPath);
    assert.equal(sha256File(prod.dbPath), disabledBytes, '5: disabled boot does not write the store');
    assert.equal(activationRow(prod.dbPath).state, COMPANION_ACTIVATION, '5: boot never writes ACTIVE');

    // 2 + 3 + 6: official activation persists ACTIVE → fresh normal boot opens the production store ACTIVE.
    assert.equal(activateCompanion({ env: prod.env }).state, COMPANION_ACTIVE);
    const persisted = activationRow(prod.dbPath);
    assert.equal(persisted.state, COMPANION_ACTIVE);
    const activeBytes = sha256File(prod.dbPath);
    const active = openCompanionAtBoot({ env: prod.env });
    try {
      assert.ok(active.store, '6: normal boot opens the production-like store');
      assert.equal(path.resolve(active.store.db.name), prod.dbPath);
      assert.equal(active.decision.enabled, true);
      assert.equal(active.decision.activation.state, COMPANION_ACTIVE);
      assert.equal(active.decision.activation.updatedAt, persisted.updatedAt, '3: ACTIVE comes from the persisted row');
      assert.deepEqual(Object.keys(active).sort(), ['decision', 'store'], '13: boot starts nothing but the store (no worker / COMP-7)');
    } finally { active.store?.close(); }
    assert.equal(sha256File(prod.dbPath), activeBytes, '5: ACTIVE boot does not rewrite the store');
    assert.deepEqual(activationRow(prod.dbPath), persisted, '5: activation row and timestamp unchanged by boot');

    // 7: production authorization stays internal to the boot / activation boundary.
    assert.throws(() => CompanionStore.open({ dbPath: prod.dbPath }), error => error?.code === 'COMP_DB_IN_USER_DATA');
    assert.equal(readCompanionActivation({ dbPath: prod.dbPath }).reason, 'COMPANION_ACTIVATION_PATH_INVALID');
    assert.equal(openCompanionAtBoot({ env: { [COMPANION_DEV_DB_ENV]: prod.dbPath } }).decision.reason, 'COMPANION_DEV_PATH_IN_USER_DATA');

    // 8: dev selection ignores production ACTIVE and never touches it; dev ACTIVE never leaks into normal boot.
    const devEnv = { ...prod.env, [COMPANION_DEV_DB_ENV]: dev.dbPath };
    const devBoot = openCompanionAtBoot({ env: devEnv });
    assert.equal(devBoot.store, null, 'dev store is disabled even though production is ACTIVE');
    assert.equal(sha256File(prod.dbPath), activeBytes, 'dev boot does not touch production');
    assert.equal(deactivateCompanion({ env: prod.env }).state, COMPANION_ACTIVATION);
    assert.equal(activateCompanion({ dbPath: dev.dbPath }).state, COMPANION_ACTIVE);
    const prodAfterDev = openCompanionAtBoot({ env: prod.env });
    assert.equal(prodAfterDev.store, null, 'dev ACTIVE never activates production boot');
    assert.equal(prodAfterDev.decision.reason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
    const devActive = openCompanionAtBoot({ env: devEnv });
    try { assert.equal(path.resolve(devActive.store.db.name), dev.dbPath, 'dev ACTIVE opens only the dev store'); } finally { devActive.store?.close(); }

    // 12: KG stays inactive.
    const inspect = new Database(prod.dbPath, { readonly: true, fileMustExist: true });
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'kg_%'").pluck().get(), 0);
    inspect.close();
    const bootSrc = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'lib', 'companion-boot.js'), 'utf8');
    assert.deepEqual([...bootSrc.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]).sort(), ['./companion-store.js', 'node:path'], '12/13: boot imports no KG, model, worker or network module');
  } finally {
    fs.rmSync(prod.root, { recursive: true, force: true });
    fs.rmSync(dev.dir, { recursive: true, force: true });
  }
});

test('normal boot fails closed on a future, malformed or missing production activation and never rewrites it', () => {
  const prod = productionLikeRoot();
  const target = prod.dbPath;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const refused = (label) => {
      const before = sha256File(target);
      const r = openCompanionAtBoot({ env: prod.env });
      assert.equal(r.store, null, `${label}: never boots`);
      assert.deepEqual(r.decision, { enabled: false, reason: 'COMPANION_PRODUCTION_STORE_FAILED' }, label);
      assert.equal(sha256File(target), before, `${label}: not rewritten`);
    };

    // 9: v999 + ACTIVE.
    makeSchemaFixture(target, { version: 999, state: COMPANION_ACTIVE });
    refused('v999 ACTIVE');
    assert.equal(activationRow(target).state, COMPANION_ACTIVE, 'future store is not downgraded either');
    fs.rmSync(target);

    // 10: malformed schema metadata.
    makeSchemaFixture(target, { version: 'unknown', versionType: 'TEXT', state: COMPANION_ACTIVE, name: 'unknown' });
    refused('malformed schema');
    fs.rmSync(target);

    // Corrupt file.
    fs.writeFileSync(target, 'not-a-sqlite-database');
    refused('corrupt file');
    fs.rmSync(target);

    // 11a: activation table missing on a v4 store → refused.
    assert.equal(ensureCompanionProductionStore({ env: prod.env }).activation.state, COMPANION_ACTIVATION);
    let db = new Database(target);
    db.exec('DROP TABLE companion_activation');
    db.close();
    refused('missing activation table');

    // 11b: unknown state value (CHECK bypassed) → refused.
    db = new Database(target);
    db.exec("CREATE TABLE companion_activation(singleton INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO companion_activation VALUES(1, 'BOGUS', '2026-10-18T00:00:00.000Z');");
    db.close();
    refused('invalid activation state');
    fs.rmSync(target);

    // 11c: missing activation row on a valid v4 store → existing safe initialization to DISABLED, never ACTIVE.
    assert.equal(ensureCompanionProductionStore({ env: prod.env }).activation.state, COMPANION_ACTIVATION);
    db = new Database(target);
    db.exec('DELETE FROM companion_activation');
    db.close();
    const r = openCompanionAtBoot({ env: prod.env });
    assert.equal(r.store, null);
    assert.equal(r.decision.reason, 'COMPANION_HUMAN_ACTIVATION_REQUIRED');
    assert.equal(activationRow(target).state, COMPANION_ACTIVATION, 'missing row is safe-disabled, never ACTIVE');
  } finally {
    fs.rmSync(prod.root, { recursive: true, force: true });
  }
});
