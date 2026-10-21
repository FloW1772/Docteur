// [GAME-2] Docteur Arcade — host ↔ game postMessage protocol v1 (game side: public/arcade/synapse-run/foundation.js).
// The game page runs in <iframe sandbox="allow-scripts"> (opaque origin "null"), so event.origin proves nothing:
// the host accepts a message only if event.source is the live iframe's contentWindow AND the envelope is exactly
// one of the shapes below for the current gameId + instanceId. Everything else is dropped without side effect.
// [GAME-3] Save requests add one top-level key, requestId, echoed by the host's ARCADE_SAVE_RESULT. The game names
// an operation on ITS OWN save only: no key, database, store or other game can be expressed in a request.
import { ARCADE_GAMES, ARCADE_ROUTE_PATTERN, type ArcadeGameId } from './registry.ts';
import type { ArcadeSaveData, ArcadeSaveErrorCode } from './saves.ts';

export const ARCADE_CHANNEL = 'docteur-arcade';
export const ARCADE_PROTOCOL_VERSION = 1;

/**
 * Exact sandbox tokens. allow-scripts only: the page needs JS, nothing else. Deliberately absent:
 * allow-same-origin (would hand the game Docteur's origin: storage, cookies, API), allow-top-navigation*,
 * allow-popups*, allow-forms, allow-modals, allow-downloads, allow-pointer-lock, allow-orientation-lock,
 * allow-presentation, allow-storage-access-by-user-activation.
 */
export const ARCADE_IFRAME_SANDBOX = 'allow-scripts';

/** Permissions Policy for the frame: no device, capture, payment or clipboard feature is delegated. */
export const ARCADE_IFRAME_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'";

export type ArcadeHostCommandType = 'ARCADE_INIT' | 'ARCADE_PAUSE' | 'ARCADE_RESUME' | 'ARCADE_STOP';
export type ArcadeGameEventType = 'ARCADE_READY' | 'ARCADE_STATE' | 'ARCADE_ERROR';
export type ArcadeSaveRequestType = 'ARCADE_SAVE_LOAD' | 'ARCADE_SAVE_WRITE' | 'ARCADE_SAVE_DELETE';
export type ArcadeSaveOperation = 'LOAD' | 'WRITE' | 'DELETE';
export type ArcadeGameState = 'active' | 'paused' | 'stopped';
/** Fixed set: the host shows its own text for each code, never game-supplied text. */
export type ArcadeErrorCode = 'GAME_RUNTIME_ERROR';

type EmptyPayload = Record<string, never>;

interface Envelope<T extends string, P> {
  channel: typeof ARCADE_CHANNEL;
  v: typeof ARCADE_PROTOCOL_VERSION;
  type: T;
  gameId: ArcadeGameId;
  instanceId: string;
  payload: P;
}

export type ArcadeHostCommand =
  | Envelope<'ARCADE_INIT', { reducedMotion: boolean }>
  | Envelope<'ARCADE_PAUSE', EmptyPayload>
  | Envelope<'ARCADE_RESUME', EmptyPayload>
  | Envelope<'ARCADE_STOP', EmptyPayload>;

type RequestEnvelope<T extends string, P> = Envelope<T, P> & { requestId: string };

/** saveVersion / data are only shape-checked here; their content is validated by the save store (saves.ts). */
export type ArcadeSaveRequest =
  | RequestEnvelope<'ARCADE_SAVE_LOAD', EmptyPayload>
  | RequestEnvelope<'ARCADE_SAVE_WRITE', { saveVersion: unknown; data: unknown }>
  | RequestEnvelope<'ARCADE_SAVE_DELETE', EmptyPayload>;

export type ArcadeGameEvent =
  | Envelope<'ARCADE_READY', EmptyPayload>
  | Envelope<'ARCADE_STATE', { state: ArcadeGameState }>
  | Envelope<'ARCADE_ERROR', { code: ArcadeErrorCode }>
  | ArcadeSaveRequest;

/** Timestamps are the host's; the game never supplies them. */
export interface ArcadeSaveResultMeta { saveVersion: number; createdAt: number; updatedAt: number }

export type ArcadeSaveResultPayload =
  | { op: 'LOAD'; status: 'EMPTY' }
  | { op: 'LOAD'; status: 'FOUND'; save: ArcadeSaveResultMeta & { data: ArcadeSaveData } }
  | { op: 'WRITE'; status: 'SAVED'; save: ArcadeSaveResultMeta }
  | { op: 'DELETE'; status: 'DELETED' }
  | { op: ArcadeSaveOperation; status: 'ERROR'; code: ArcadeSaveErrorCode };

export type ArcadeSaveResult = RequestEnvelope<'ARCADE_SAVE_RESULT', ArcadeSaveResultPayload>;

const ENVELOPE_KEYS = 'channel,gameId,instanceId,payload,type,v';
const REQUEST_ENVELOPE_KEYS = 'channel,gameId,instanceId,payload,requestId,type,v';
const GAME_STATES: readonly string[] = ['active', 'paused', 'stopped'];
const ERROR_CODES: readonly string[] = ['GAME_RUNTIME_ERROR'];
const INSTANCE_ID = /^[0-9a-f]{32}$/;
/** 64-bit lowercase hex chosen by the game; it only correlates a result with its request. */
const REQUEST_ID = /^[0-9a-f]{16}$/;

/** A fresh per-launch id (128 random bits, lowercase hex). A new launch never reuses one. */
export function createArcadeInstanceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function isArcadeInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_ID.test(value);
}

export function isArcadeRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

/** The iframe URL: the registry route plus the instance id in the fragment (never sent over the network). */
export function arcadeFrameSrc(route: string, instanceId: string): string {
  if (!ARCADE_ROUTE_PATTERN.test(route) || !ARCADE_GAMES.some(game => game.route === route)) throw new Error('ARCADE_BAD_ROUTE');
  if (!isArcadeInstanceId(instanceId)) throw new Error('ARCADE_BAD_INSTANCE_ID');
  return `${route}#instance=${instanceId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function keySet(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}

/**
 * Validates a raw message.data against the protocol for the expected game + instance.
 * Returns the typed event, or null for anything else (unknown type, other game, stale instance, extra keys,
 * wrong payload shape). Never throws, never dispatches on the raw string.
 */
export function parseArcadeGameEvent(data: unknown, expected: { gameId: ArcadeGameId; instanceId: string }): ArcadeGameEvent | null {
  if (!isPlainObject(data)) return null;
  const envelopeKeys = keySet(data);
  if (envelopeKeys !== ENVELOPE_KEYS && envelopeKeys !== REQUEST_ENVELOPE_KEYS) return null;
  if (data.channel !== ARCADE_CHANNEL || data.v !== ARCADE_PROTOCOL_VERSION) return null;
  if (data.gameId !== expected.gameId || data.instanceId !== expected.instanceId || !isArcadeInstanceId(data.instanceId)) return null;
  const payload = data.payload;
  if (!isPlainObject(payload)) return null;
  const base = { channel: ARCADE_CHANNEL, v: ARCADE_PROTOCOL_VERSION, gameId: expected.gameId, instanceId: expected.instanceId } as const;
  if (envelopeKeys === REQUEST_ENVELOPE_KEYS) {
    if (!isArcadeRequestId(data.requestId)) return null;
    const request = { ...base, requestId: data.requestId };
    switch (data.type) {
      case 'ARCADE_SAVE_LOAD':
        return keySet(payload) === '' ? { ...request, type: 'ARCADE_SAVE_LOAD', payload: {} } : null;
      case 'ARCADE_SAVE_WRITE':
        return keySet(payload) === 'data,saveVersion' ? { ...request, type: 'ARCADE_SAVE_WRITE', payload: { saveVersion: payload.saveVersion, data: payload.data } } : null;
      case 'ARCADE_SAVE_DELETE':
        return keySet(payload) === '' ? { ...request, type: 'ARCADE_SAVE_DELETE', payload: {} } : null;
      default:
        return null;
    }
  }
  switch (data.type) {
    case 'ARCADE_READY':
      return keySet(payload) === '' ? { ...base, type: 'ARCADE_READY', payload: {} } : null;
    case 'ARCADE_STATE':
      return keySet(payload) === 'state' && typeof payload.state === 'string' && GAME_STATES.includes(payload.state)
        ? { ...base, type: 'ARCADE_STATE', payload: { state: payload.state as ArcadeGameState } }
        : null;
    case 'ARCADE_ERROR':
      return keySet(payload) === 'code' && typeof payload.code === 'string' && ERROR_CODES.includes(payload.code)
        ? { ...base, type: 'ARCADE_ERROR', payload: { code: payload.code as ArcadeErrorCode } }
        : null;
    default:
      return null;
  }
}

export function buildArcadeHostCommand(type: 'ARCADE_INIT', gameId: ArcadeGameId, instanceId: string, payload: { reducedMotion: boolean }): ArcadeHostCommand;
export function buildArcadeHostCommand(type: 'ARCADE_PAUSE' | 'ARCADE_RESUME' | 'ARCADE_STOP', gameId: ArcadeGameId, instanceId: string): ArcadeHostCommand;
export function buildArcadeHostCommand(type: ArcadeHostCommandType, gameId: ArcadeGameId, instanceId: string, payload?: { reducedMotion: boolean }): ArcadeHostCommand {
  if (!isArcadeInstanceId(instanceId)) throw new Error('ARCADE_BAD_INSTANCE_ID');
  const base = { channel: ARCADE_CHANNEL, v: ARCADE_PROTOCOL_VERSION, gameId, instanceId } as const;
  if (type === 'ARCADE_INIT') return { ...base, type, payload: { reducedMotion: payload?.reducedMotion === true } };
  return { ...base, type, payload: {} };
}

export function buildArcadeSaveResult(gameId: ArcadeGameId, instanceId: string, requestId: string, payload: ArcadeSaveResultPayload): ArcadeSaveResult {
  if (!isArcadeInstanceId(instanceId)) throw new Error('ARCADE_BAD_INSTANCE_ID');
  if (!isArcadeRequestId(requestId)) throw new Error('ARCADE_BAD_REQUEST_ID');
  return { channel: ARCADE_CHANNEL, v: ARCADE_PROTOCOL_VERSION, type: 'ARCADE_SAVE_RESULT', gameId, instanceId, requestId, payload };
}
