// [GAME-3] Docteur Arcade — local save store, owned by the trusted host (never by the sandboxed game page).
// One record per registered game in a dedicated IndexedDB database (not the Notebook "docteur-db", not any
// Companion / Cortex / Device Fabric store). The game only ever reaches it through the host protocol
// (ARCADE_SAVE_LOAD / _WRITE / _DELETE in protocol.ts); the key is derived from the registry entry, never from input.
//
//   IndexedDB "docteur-arcade" v1 → object store "saves" → key "arcade:v1:<gameId>" →
//   { schema, gameId, saveVersion, createdAt, updatedAt, bytes, payload }
//
// schema      = this file's record format (ARCADE_SAVE_SCHEMA_VERSION); a newer one is preserved, never reinterpreted
// saveVersion = the game's own data version, accepted within the registry's save policy window
// createdAt / updatedAt = host clock (ms), the game cannot supply them
// payload     = JSON-safe data only, ≤ 64 KiB as UTF-8 JSON, stored in its JSON-normalised form
//
// Not idb-keyval: its createStore keeps a rejected open promise until reload and cannot tell "storage unavailable"
// from "transaction failed". This adapter reopens after a failure and reports one of a fixed set of codes.
import { getArcadeGame, type ArcadeGameEntry, type ArcadeGameId } from './registry.ts';

export const ARCADE_SAVE_DB_NAME = 'docteur-arcade';
export const ARCADE_SAVE_DB_VERSION = 1;
export const ARCADE_SAVE_OBJECT_STORE = 'saves';
export const ARCADE_SAVE_SCHEMA_VERSION = 1;
export const ARCADE_SAVE_MAX_BYTES = 65_536;
/** Upper bound for any saveVersion, whatever the game's policy says. */
export const ARCADE_SAVE_MAX_VERSION = 1_000_000;
/** Nesting bound for payload arrays/objects (keeps validation and JSON.stringify far from stack limits). */
export const ARCADE_SAVE_MAX_DEPTH = 32;

export type ArcadeSaveErrorCode =
  | 'UNKNOWN_GAME'
  | 'INVALID_SAVE_VERSION'
  | 'INVALID_SAVE_PAYLOAD'
  | 'SAVE_TOO_LARGE'
  | 'CORRUPT_SAVE'
  | 'UNSUPPORTED_SAVE_VERSION'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FAILED'
  | 'SAVE_BUSY';

export const ARCADE_SAVE_ERROR_CODES: readonly ArcadeSaveErrorCode[] = Object.freeze([
  'UNKNOWN_GAME', 'INVALID_SAVE_VERSION', 'INVALID_SAVE_PAYLOAD', 'SAVE_TOO_LARGE', 'CORRUPT_SAVE',
  'UNSUPPORTED_SAVE_VERSION', 'STORAGE_UNAVAILABLE', 'STORAGE_FAILED', 'SAVE_BUSY',
]);

export type ArcadeSaveData = null | boolean | number | string | ArcadeSaveData[] | { [key: string]: ArcadeSaveData };

export interface ArcadeSaveMeta {
  saveVersion: number;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export type ArcadeSaveLoadResult =
  | { ok: true; status: 'EMPTY' }
  | { ok: true; status: 'FOUND'; save: ArcadeSaveMeta & { data: ArcadeSaveData } }
  | { ok: false; code: ArcadeSaveErrorCode };
export type ArcadeSaveWriteResult = { ok: true; status: 'SAVED'; save: ArcadeSaveMeta } | { ok: false; code: ArcadeSaveErrorCode };
export type ArcadeSaveDeleteResult = { ok: true; status: 'DELETED' } | { ok: false; code: ArcadeSaveErrorCode };

export interface ArcadeSaveStore {
  load(gameId: unknown): Promise<ArcadeSaveLoadResult>;
  write(gameId: unknown, saveVersion: unknown, data: unknown): Promise<ArcadeSaveWriteResult>;
  remove(gameId: unknown): Promise<ArcadeSaveDeleteResult>;
}

/** A storage-layer failure with a fixed code (the browser's own error text is never surfaced). */
export class ArcadeSaveStorageError extends Error {
  readonly code: 'STORAGE_UNAVAILABLE' | 'STORAGE_FAILED';
  constructor(code: 'STORAGE_UNAVAILABLE' | 'STORAGE_FAILED') {
    super(code);
    this.code = code;
  }
}

/** Thrown inside an update callback to refuse the write; the transaction then writes nothing. */
class ArcadeSaveRefusal extends Error {
  readonly code: ArcadeSaveErrorCode;
  constructor(code: ArcadeSaveErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Exactly three keyed operations. update() reads and replaces the record in ONE readwrite transaction: if the
 * callback throws, or the transaction aborts, nothing is written and the previous record stays as it was.
 */
export interface ArcadeSaveBackend {
  get(key: string): Promise<unknown>;
  update(key: string, next: (current: unknown) => unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Key for a registered game with a save policy; everything else (paths, URLs, other ids) has no key. */
export function arcadeSaveKey(game: ArcadeGameEntry): string {
  return `arcade:v1:${game.id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Checks that `data` is plain JSON (null, boolean, finite number, string, dense plain array, plain object with
 * data properties only, depth ≤ ARCADE_SAVE_MAX_DEPTH) and measures it as UTF-8 JSON. Stops early once the
 * serialised size is certain to exceed the bound. Never throws.
 */
export function measureArcadeSaveData(data: unknown): { ok: true; json: string; bytes: number } | { ok: false; code: 'INVALID_SAVE_PAYLOAD' | 'SAVE_TOO_LARGE' } {
  // every node serialises to ≥ 1 byte and every string to ≥ its UTF-16 length, so this is a lower bound
  let minBytes = 0;
  const walk = (value: unknown, depth: number): 'INVALID_SAVE_PAYLOAD' | 'SAVE_TOO_LARGE' | null => {
    minBytes += 1;
    if (minBytes > ARCADE_SAVE_MAX_BYTES) return 'SAVE_TOO_LARGE';
    if (value === null || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? null : 'INVALID_SAVE_PAYLOAD';
    if (typeof value === 'string') {
      minBytes += value.length;
      return minBytes > ARCADE_SAVE_MAX_BYTES ? 'SAVE_TOO_LARGE' : null;
    }
    if (typeof value !== 'object' || depth >= ARCADE_SAVE_MAX_DEPTH) return 'INVALID_SAVE_PAYLOAD';
    const isArray = Array.isArray(value);
    if (isArray ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) return 'INVALID_SAVE_PAYLOAD';
    if (Object.getOwnPropertySymbols(value).length > 0) return 'INVALID_SAVE_PAYLOAD';
    const keys = Object.keys(value);
    if (isArray) {
      // dense, index keys only: no holes, no named or hidden extra properties
      const length = (value as unknown[]).length;
      if (keys.length !== length || Object.getOwnPropertyNames(value).length !== length + 1) return 'INVALID_SAVE_PAYLOAD';
      for (let index = 0; index < length; index++) if (!Object.prototype.hasOwnProperty.call(value, index)) return 'INVALID_SAVE_PAYLOAD';
    } else if (Object.getOwnPropertyNames(value).length !== keys.length) {
      return 'INVALID_SAVE_PAYLOAD';
    }
    for (const key of keys) {
      if (!isArray && key === '__proto__') return 'INVALID_SAVE_PAYLOAD';
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return 'INVALID_SAVE_PAYLOAD';
      if (!isArray) {
        minBytes += key.length + 3;
        if (minBytes > ARCADE_SAVE_MAX_BYTES) return 'SAVE_TOO_LARGE';
      }
      const problem = walk(descriptor.value, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  const problem = walk(data, 0);
  if (problem) return { ok: false, code: problem };
  let json: string;
  try { json = JSON.stringify(data); } catch { return { ok: false, code: 'INVALID_SAVE_PAYLOAD' }; }
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes > ARCADE_SAVE_MAX_BYTES ? { ok: false, code: 'SAVE_TOO_LARGE' } : { ok: true, json, bytes };
}

const RECORD_KEYS = 'bytes,createdAt,gameId,payload,saveVersion,schema,updatedAt';

interface StoredRecord extends ArcadeSaveMeta {
  schema: typeof ARCADE_SAVE_SCHEMA_VERSION;
  gameId: ArcadeGameId;
  payload: ArcadeSaveData;
}

/** Reads a stored value for `game`. Unknown future schema / saveVersion → UNSUPPORTED (record left untouched). */
function readRecord(raw: unknown, game: ArcadeGameEntry): { ok: true; record: StoredRecord } | { ok: false; code: 'CORRUPT_SAVE' | 'UNSUPPORTED_SAVE_VERSION' } {
  const policy = game.save;
  if (!policy || !isPlainObject(raw)) return { ok: false, code: 'CORRUPT_SAVE' };
  if (!isBoundedInteger(raw.schema, 1, ARCADE_SAVE_MAX_VERSION)) return { ok: false, code: 'CORRUPT_SAVE' };
  if (raw.schema !== ARCADE_SAVE_SCHEMA_VERSION) return { ok: false, code: raw.schema > ARCADE_SAVE_SCHEMA_VERSION ? 'UNSUPPORTED_SAVE_VERSION' : 'CORRUPT_SAVE' };
  if (Object.keys(raw).sort().join(',') !== RECORD_KEYS || raw.gameId !== game.id) return { ok: false, code: 'CORRUPT_SAVE' };
  const { saveVersion, createdAt, updatedAt, bytes } = raw;
  if (!isBoundedInteger(saveVersion, 1, ARCADE_SAVE_MAX_VERSION)) return { ok: false, code: 'CORRUPT_SAVE' };
  if (!isBoundedInteger(createdAt, 0, Number.MAX_SAFE_INTEGER) || !isBoundedInteger(updatedAt, createdAt, Number.MAX_SAFE_INTEGER)) return { ok: false, code: 'CORRUPT_SAVE' };
  const measured = measureArcadeSaveData(raw.payload);
  if (!measured.ok || measured.bytes !== bytes) return { ok: false, code: 'CORRUPT_SAVE' };
  if (saveVersion < policy.minSupportedVersion || saveVersion > policy.currentVersion) return { ok: false, code: 'UNSUPPORTED_SAVE_VERSION' };
  return { ok: true, record: { schema: ARCADE_SAVE_SCHEMA_VERSION, gameId: game.id, saveVersion, createdAt, updatedAt, bytes, payload: raw.payload as ArcadeSaveData } };
}

function storageCode(error: unknown): ArcadeSaveErrorCode {
  if (error instanceof ArcadeSaveRefusal) return error.code;
  if (error instanceof ArcadeSaveStorageError) return error.code;
  return 'STORAGE_FAILED';
}

interface StoreOptions {
  backend: ArcadeSaveBackend;
  /** host clock in ms; injectable for tests */
  now?: () => number;
  /** registry lookup; injectable for tests (production: the fixed ARCADE_GAMES registry) */
  getGame?: (id: unknown) => ArcadeGameEntry | null;
}

export function createArcadeSaveStore({ backend, now = Date.now, getGame = getArcadeGame }: StoreOptions): ArcadeSaveStore {
  const savableGame = (gameId: unknown): ArcadeGameEntry | null => {
    const game = getGame(gameId);
    return game && game.save && game.capabilities.includes('LOCAL_SAVE_V1') ? game : null;
  };
  const clock = (): number => {
    const value = Math.floor(now());
    return isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER) ? value : 0;
  };

  return {
    async load(gameId) {
      const game = savableGame(gameId);
      if (!game) return { ok: false, code: 'UNKNOWN_GAME' };
      let raw: unknown;
      try { raw = await backend.get(arcadeSaveKey(game)); } catch (error) { return { ok: false, code: storageCode(error) }; }
      if (raw === undefined) return { ok: true, status: 'EMPTY' };
      const read = readRecord(raw, game);
      if (!read.ok) return read;
      const { saveVersion, createdAt, updatedAt, bytes, payload } = read.record;
      return { ok: true, status: 'FOUND', save: { saveVersion, createdAt, updatedAt, bytes, data: payload } };
    },

    async write(gameId, saveVersion, data) {
      const game = savableGame(gameId);
      if (!game || !game.save) return { ok: false, code: 'UNKNOWN_GAME' };
      const policy = game.save;
      if (!isBoundedInteger(saveVersion, 1, ARCADE_SAVE_MAX_VERSION) || saveVersion < policy.minSupportedVersion || saveVersion > policy.currentVersion) {
        return { ok: false, code: 'INVALID_SAVE_VERSION' };
      }
      const measured = measureArcadeSaveData(data);
      if (!measured.ok) return measured;
      // the stored payload is the JSON-normalised copy, so what was measured is exactly what is kept
      const payload = JSON.parse(measured.json) as ArcadeSaveData;
      let written: StoredRecord | null = null;
      try {
        await backend.update(arcadeSaveKey(game), current => {
          let createdAt: number | null = null, previousUpdate = 0;
          if (current !== undefined) {
            // an unreadable or newer record is never overwritten implicitly: the user resets it explicitly
            const read = readRecord(current, game);
            if (!read.ok) throw new ArcadeSaveRefusal(read.code);
            createdAt = read.record.createdAt;
            previousUpdate = read.record.updatedAt;
          }
          const timestamp = clock();
          const updatedAt = Math.max(timestamp, previousUpdate, createdAt ?? 0);
          written = { schema: ARCADE_SAVE_SCHEMA_VERSION, gameId: game.id, saveVersion, createdAt: createdAt ?? updatedAt, updatedAt, bytes: measured.bytes, payload };
          return written;
        });
      } catch (error) {
        return { ok: false, code: storageCode(error) };
      }
      const record = written as StoredRecord | null;
      if (!record) return { ok: false, code: 'STORAGE_FAILED' };
      return { ok: true, status: 'SAVED', save: { saveVersion: record.saveVersion, createdAt: record.createdAt, updatedAt: record.updatedAt, bytes: record.bytes } };
    },

    async remove(gameId) {
      const game = savableGame(gameId);
      if (!game) return { ok: false, code: 'UNKNOWN_GAME' };
      try { await backend.delete(arcadeSaveKey(game)); } catch (error) { return { ok: false, code: storageCode(error) }; }
      return { ok: true, status: 'DELETED' };
    },
  };
}

/** IndexedDB adapter for the dedicated Arcade database. `factory` is injectable for tests. */
export function createIdbSaveBackend(factory: () => IDBFactory | undefined = () => globalThis.indexedDB): ArcadeSaveBackend {
  let connection: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (connection) return connection;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const unavailable = () => reject(new ArcadeSaveStorageError('STORAGE_UNAVAILABLE'));
      let request: IDBOpenDBRequest;
      try {
        const idb = factory();
        if (!idb) { unavailable(); return; }
        request = idb.open(ARCADE_SAVE_DB_NAME, ARCADE_SAVE_DB_VERSION);
      } catch {
        unavailable();
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ARCADE_SAVE_OBJECT_STORE)) db.createObjectStore(ARCADE_SAVE_OBJECT_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        const forget = () => { if (connection === pending) connection = null; };
        db.onversionchange = () => { db.close(); forget(); };
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = unavailable;
    });
    // a failed open is retried on the next operation instead of being cached
    pending.catch(() => { if (connection === pending) connection = null; });
    connection = pending;
    return pending;
  };

  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, refuse: (error: unknown) => void) => () => T): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let refusal: unknown = null;
      let tx: IDBTransaction;
      let result: () => T;
      try {
        tx = db.transaction(ARCADE_SAVE_OBJECT_STORE, mode);
        result = body(tx.objectStore(ARCADE_SAVE_OBJECT_STORE), error => {
          refusal = error;
          try { tx.abort(); } catch { /* already finished */ }
        });
      } catch {
        connection = null;
        reject(new ArcadeSaveStorageError('STORAGE_FAILED'));
        return;
      }
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(refusal ?? new ArcadeSaveStorageError('STORAGE_FAILED'));
    });
  };

  return {
    get: key => run('readonly', store => {
      const request = store.get(key);
      return () => request.result as unknown;
    }),
    update: (key, next) => run('readwrite', (store, refuse) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try { store.put(next(request.result), key); } catch (error) { refuse(error); }
      };
      return () => undefined;
    }),
    delete: key => run('readwrite', store => {
      store.delete(key);
      return () => undefined;
    }),
  };
}

let defaultStore: ArcadeSaveStore | null = null;

/** The host's store: dedicated IndexedDB database, fixed registry. */
export function getArcadeSaveStore(): ArcadeSaveStore {
  defaultStore ??= createArcadeSaveStore({ backend: createIdbSaveBackend() });
  return defaultStore;
}
