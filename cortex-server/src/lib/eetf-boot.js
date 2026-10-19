// EETF V1 — boot gate (EETF-2).
//
// Until EETF-CERT passes, a normal Docteur start NEVER initialises EETF: no
// eetf_* table in the user database, no cortex-server/data/eetf folder.
// This module is not even imported by server.js in EETF-2; the route wiring
// that will call it comes with the UI checkpoint.
//
// Development / test only: DOCTEUR_EETF_DEV_DB=<absolute .sqlite path> AND
// DOCTEUR_EETF_DEV_ROOT=<absolute folder> open EETF on that SEPARATE database
// and asset folder. Both are refused when they designate the user data
// directory (cortex-server/data) or anything inside it.

import path from 'node:path';
import { EetfStore } from './eetf-store.js';
import { isInUserData } from './eetf-asset-store.js';

export const EETF_CERTIFIED = false;
export const EETF_DEV_DB_ENV = 'DOCTEUR_EETF_DEV_DB';
export const EETF_DEV_ROOT_ENV = 'DOCTEUR_EETF_DEV_ROOT';

/** Pure decision: nothing is opened or created here. */
export function resolveEetfBoot({ env = process.env } = {}) {
  const dbPath = typeof env[EETF_DEV_DB_ENV] === 'string' ? env[EETF_DEV_DB_ENV].trim() : '';
  const root = typeof env[EETF_DEV_ROOT_ENV] === 'string' ? env[EETF_DEV_ROOT_ENV].trim() : '';
  if (!dbPath && !root) return { enabled: false, reason: EETF_CERTIFIED ? 'EETF_NOT_REQUESTED' : 'EETF_UNCERTIFIED_DISABLED' };
  if (!dbPath || !root) return { enabled: false, reason: 'EETF_DEV_CONFIG_INCOMPLETE' };
  if (!path.isAbsolute(dbPath) || !path.isAbsolute(root)) return { enabled: false, reason: 'EETF_DEV_PATH_NOT_ABSOLUTE' };
  if (isInUserData(dbPath) || isInUserData(root)) return { enabled: false, reason: 'EETF_DEV_PATH_IN_USER_DATA' };
  return { enabled: true, reason: 'EETF_DEV_SEPARATE_STORE', dbPath, root };
}

/**
 * Opens EETF when the gate allows it (and recovers interrupted jobs), else
 * returns { store: null }. Never throws into a server boot.
 */
export function openEetfAtBoot({ env = process.env, logger = null } = {}) {
  const decision = resolveEetfBoot({ env });
  if (!decision.enabled) {
    logger?.info?.({ reason: decision.reason }, 'EETF disabled');
    return { store: null, decision, recovery: null };
  }
  try {
    const store = EetfStore.open({ dbPath: decision.dbPath, assetRoot: decision.root });
    const recovery = store.recoverAfterRestart();
    logger?.warn?.({ reason: decision.reason, recovery }, 'EETF enabled on a separate development store (uncertified)');
    return { store, decision, recovery };
  } catch (error) {
    logger?.error?.({ err: error.message }, 'EETF failed to open; disabled');
    return { store: null, decision: { enabled: false, reason: 'EETF_OPEN_FAILED' }, recovery: null };
  }
}
