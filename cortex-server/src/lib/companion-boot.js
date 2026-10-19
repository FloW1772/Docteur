// Companion V1 — COMP-2 boot gate.
//
// A certified normal Docteur start initialises only the dedicated production store. It never puts companion_* tables in
// the canonical user database and never starts the model, worker, network, memory retrieval, KG, or COMP-7 until an
// explicit human activation exists.
//
// Development / test only: DOCTEUR_COMPANION_DEV_DB=<absolute .sqlite path> selects a SEPARATE store outside the user
// data directory. It remains independent from the official production target.

import path from 'node:path';
import { CompanionStore, USER_DATA_DIR, isInUserData } from './companion-store.js';

export const COMPANION_CERTIFIED = true;
export const COMPANION_ACTIVATION = 'DISABLED_PENDING_HUMAN_ACTIVATION';
export const COMPANION_ACTIVE = 'ACTIVE';
export const COMPANION_DEV_DB_ENV = 'DOCTEUR_COMPANION_DEV_DB';
export const COMPANION_PRODUCTION_RELATIVE_PATH = path.join('companion-v1', 'companion.sqlite');

const SERVER_ROOT = path.dirname(USER_DATA_DIR);

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveCanonicalStorePath(env) {
  // Match server.js exactly: relative SQLITE_PATH values are rooted at cortex-server, never at process.cwd().
  return path.resolve(SERVER_ROOT, env.SQLITE_PATH ?? './data/cortex.sqlite');
}

/** Pure decision: nothing is opened or created here. */
export function resolveCompanionBoot({ env = process.env } = {}) {
  const dbPath = typeof env[COMPANION_DEV_DB_ENV] === 'string' ? env[COMPANION_DEV_DB_ENV].trim() : '';
  if (!dbPath) return { enabled: false, reason: COMPANION_CERTIFIED ? 'COMPANION_NOT_REQUESTED' : 'COMPANION_UNCERTIFIED_DISABLED' };
  if (!path.isAbsolute(dbPath)) return { enabled: false, reason: 'COMPANION_DEV_PATH_NOT_ABSOLUTE' };
  if (isInUserData(dbPath)) return { enabled: false, reason: 'COMPANION_DEV_PATH_IN_USER_DATA' };
  return { enabled: true, reason: 'COMPANION_DEV_SEPARATE_STORE', dbPath };
}

export function resolveCompanionProductionStorePath({ env = process.env, productDataRoot = null } = {}) {
  const canonical = resolveCanonicalStorePath(env);
  const root = productDataRoot === null ? path.dirname(canonical) : path.resolve(productDataRoot);
  const target = path.resolve(root, COMPANION_PRODUCTION_RELATIVE_PATH);
  if (samePath(target, canonical)) throw new Error('COMPANION_STORE_COLLISION_CANONICAL_DB');
  const devPath = typeof env[COMPANION_DEV_DB_ENV] === 'string' ? env[COMPANION_DEV_DB_ENV].trim() : '';
  if (devPath && path.isAbsolute(devPath) && samePath(target, devPath)) throw new Error('COMPANION_STORE_COLLISION_DEV_DB');
  const kgDevPath = typeof env.DOCTEUR_KG_DEV_DB === 'string' ? env.DOCTEUR_KG_DEV_DB.trim() : '';
  if (kgDevPath && path.isAbsolute(kgDevPath) && samePath(target, kgDevPath)) throw new Error('COMPANION_STORE_COLLISION_KG_DB');
  if (!isInUserData(target)) throw new Error('COMPANION_STORE_OUTSIDE_PRODUCT_DATA');
  return target;
}

function openActivationStore(dbPath, { production = false } = {}) {
  return CompanionStore.open({ dbPath, allowProductionStore: production });
}

function activationStoreTarget({ dbPath, env }) {
  const productionPath = resolveCompanionProductionStorePath({ env });
  const target = typeof dbPath === 'string' && dbPath ? dbPath : productionPath;
  return { dbPath: target, production: samePath(target, productionPath) };
}

export function ensureCompanionProductionStore({ env = process.env, productDataRoot = null } = {}) {
  const dbPath = resolveCompanionProductionStorePath({ env, productDataRoot });
  let store;
  try {
    store = openActivationStore(dbPath, { production: true });
    const activation = store.getActivationState();
    if (!activation || ![COMPANION_ACTIVATION, COMPANION_ACTIVE].includes(activation.state)) throw new Error('COMPANION_ACTIVATION_STATE_INVALID');
    return { dbPath, schemaVersion: store.schemaVersion(), activation };
  } finally { try { store?.close(); } catch { /* best effort */ } }
}

export function readCompanionActivation({ dbPath } = {}) {
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath) || isInUserData(dbPath)) return { state: COMPANION_ACTIVATION, eligible: false, reason: 'COMPANION_ACTIVATION_PATH_INVALID' };
  let store;
  try {
    store = openActivationStore(dbPath);
    const record = store.getActivationState();
    if (!record || ![COMPANION_ACTIVATION, COMPANION_ACTIVE].includes(record.state)) return { state: COMPANION_ACTIVATION, eligible: false, reason: 'COMPANION_ACTIVATION_STATE_INVALID' };
    return { state: record.state, eligible: true, reason: record.state === COMPANION_ACTIVE ? 'COMPANION_ACTIVE' : 'COMPANION_HUMAN_ACTIVATION_REQUIRED', updatedAt: record.updatedAt };
  } catch { return { state: COMPANION_ACTIVATION, eligible: false, reason: 'COMPANION_ACTIVATION_STATE_INVALID' }; }
  finally { try { store?.close(); } catch { /* best effort */ } }
}

export function activateCompanion({ dbPath, env = process.env } = {}) {
  if (!COMPANION_CERTIFIED) return { ok: false, state: COMPANION_ACTIVATION, reason: 'COMPANION_UNCERTIFIED_DISABLED' };
  let store;
  try {
    const target = activationStoreTarget({ dbPath, env });
    store = openActivationStore(target.dbPath, { production: target.production });
    const current = store.getActivationState();
    if (current && ![COMPANION_ACTIVATION, COMPANION_ACTIVE].includes(current.state)) return { ok: false, state: COMPANION_ACTIVATION, reason: 'COMPANION_ACTIVATION_STATE_INVALID' };
    return { ok: true, state: store.setActivationState(COMPANION_ACTIVE).state, reason: 'COMPANION_ACTIVATED_EXPLICITLY' };
  } catch { return { ok: false, state: COMPANION_ACTIVATION, reason: 'COMPANION_ACTIVATION_FAILED' }; }
  finally { try { store?.close(); } catch { /* best effort */ } }
}

export function deactivateCompanion({ dbPath, env = process.env } = {}) {
  let store;
  try {
    const target = activationStoreTarget({ dbPath, env });
    store = openActivationStore(target.dbPath, { production: target.production });
    return { ok: true, state: store.setActivationState(COMPANION_ACTIVATION).state, reason: 'COMPANION_DEACTIVATED_EXPLICITLY' };
  } catch { return { ok: false, state: COMPANION_ACTIVATION, reason: 'COMPANION_DEACTIVATION_FAILED' }; }
  finally { try { store?.close(); } catch { /* best effort */ } }
}

/**
 * [COMPANION-BOOT-PROD-REMED-1] Normal boot (no dev store) opens the official production store through the same
 * resolver + narrow authorization as ensureCompanionProductionStore, and keeps it open only when the persisted
 * activation row is ACTIVE. Reading never writes the activation row; certification alone never activates.
 */
function openProductionCompanionAtBoot({ env, logger }) {
  let store;
  try {
    const dbPath = resolveCompanionProductionStorePath({ env });
    store = openActivationStore(dbPath, { production: true });
    const record = store.getActivationState();
    if (!record || ![COMPANION_ACTIVATION, COMPANION_ACTIVE].includes(record.state)) throw new Error('COMPANION_ACTIVATION_STATE_INVALID');
    const production = { dbPath, schemaVersion: store.schemaVersion(), activation: record };
    if (record.state !== COMPANION_ACTIVE) {
      store.close();
      logger?.info?.({ reason: 'COMPANION_HUMAN_ACTIVATION_REQUIRED', dbPath }, 'Companion production store ready; activation required');
      return { store: null, decision: { enabled: false, reason: 'COMPANION_HUMAN_ACTIVATION_REQUIRED', production } };
    }
    const activation = { state: record.state, eligible: true, reason: 'COMPANION_ACTIVE', updatedAt: record.updatedAt };
    logger?.info?.({ reason: activation.reason, dbPath }, 'Companion active (production store)');
    return { store, decision: { enabled: true, reason: 'COMPANION_PRODUCTION_STORE', dbPath, activation, production } };
  } catch {
    try { store?.close(); } catch { /* best effort */ }
    return { store: null, decision: { enabled: false, reason: 'COMPANION_PRODUCTION_STORE_FAILED' } };
  }
}

/** Opens the production store (normal boot) or the development store, only when persisted state is ACTIVE; else { store: null }. Never throws into a caller. */
export function openCompanionAtBoot({ env = process.env, logger = null } = {}) {
  const decision = resolveCompanionBoot({ env });
  if (!decision.enabled && decision.reason === 'COMPANION_NOT_REQUESTED') return openProductionCompanionAtBoot({ env, logger });
  if (!decision.enabled) {
    logger?.info?.({ reason: decision.reason }, 'Companion disabled');
    return { store: null, decision };
  }
  try {
    const activation = readCompanionActivation({ dbPath: decision.dbPath });
    if (activation.state !== COMPANION_ACTIVE) {
      logger?.info?.({ reason: activation.reason }, 'Companion disabled pending explicit human activation');
      return { store: null, decision: { enabled: false, reason: activation.reason, activation } };
    }
    const store = CompanionStore.open({ dbPath: decision.dbPath });
    logger?.info?.({ reason: activation.reason }, 'Companion active');
    return { store, decision: { ...decision, activation } };
  } catch (error) {
    logger?.error?.({ err: error.message }, 'Companion failed to open; disabled');
    return { store: null, decision: { enabled: false, reason: 'COMPANION_OPEN_FAILED' } };
  }
}
