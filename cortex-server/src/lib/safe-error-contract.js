// [SEC-REMED-4B] Global error boundary: an error's TEXT is untrusted unless Docteur wrote it for the client.
//
// SEC-REMED-4 closed the provider-error relay on two routes (provider-error-contract.js). The same class remained
// wherever a handler returned, logged or persisted `err.message` of an error it did not build: a model runtime, a cloud
// API, a subprocess (whisper, yt-dlp), a parser, the filesystem or SQLite can put a credential, an Authorization
// header, a private path, a stack, SQL diagnostics or their whole response body in that text.
//
// The contract:
//   • TRUSTED — a PublicError. Docteur builds it at the throw site with a stable code from the closed CODE shape, a
//     4xx/5xx status and a message WRITTEN HERE IN THE SOURCE (never interpolating another error). Its message may
//     reach the client as is.
//   • EVERYTHING ELSE (provider, subprocess, network, parser, unknown exception, internal bug) — the client receives
//     a stable code and a fixed message chosen by the caller; the text is never copied. It may be READ to pick a
//     code (classification), never echoed.
//   • Logs and persistent stores receive allowlisted, bounded fields only (safeErrorLogFields): never message,
//     stack, cause or body.
// Deciding that a text is safe because no secret regex matches it is NOT this contract: logger.js redactSecrets
// remains defense in depth only.
import { HTTPException } from 'hono/http-exception';
import { safeErrorCategory } from './provider-error-contract.js';
import { EgressDeniedError, EgressTimeoutError } from './web-egress-guard.js';

export const SAFE_INTERNAL_ERROR_MESSAGE = 'Erreur interne.';
export const SAFE_RUNTIME_UNAVAILABLE_MESSAGE = 'Le moteur de modèle local est indisponible.';

const TRUSTED = Symbol('docteur.publicError');
const CODE_RE = /^[A-Z][A-Z0-9_]{1,59}$/;
const OPERATION_RE = /^[a-z][a-z0-9_.-]{0,59}$/;
const CLASS_RE = /^[A-Z][A-Za-z0-9]{0,47}$/;

// Node / undici system codes, as a closed set written here: an upstream body can set `error.code` on an SDK error
// object, so a code is logged only when it is one of these (or the code of a PublicError). SQLite codes are left out:
// they name a diagnostic class and are not needed to operate.
const SYSTEM_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ENOSPC', 'EMFILE', 'EBUSY', 'EPIPE',
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'EADDRINUSE', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function validStatus(s) { return Number.isInteger(s) && s >= 400 && s <= 599; }

/**
 * An error whose message Docteur wrote for the client. Build it with a literal message; never pass another error's
 * text (`err.message`, `String(err)`, a provider body) into it — test-sec4b-global-error-boundaries.mjs checks the sources.
 */
export class PublicError extends Error {
  constructor(code, message, { status = 400, hint = null } = {}) {
    super(String(message));
    this.name = 'PublicError';
    this.code = CODE_RE.test(code) ? code : 'APPLICATION_ERROR';
    this.status = validStatus(status) ? status : 400;
    this.hint = typeof hint === 'string' ? hint : null;
    Object.defineProperty(this, TRUSTED, { value: true });
  }
}

export function isPublicError(error) {
  return error instanceof PublicError && error[TRUSTED] === true;
}

// Docteur error classes whose message is chosen at construction from a closed, Docteur-written table (never from
// the text of another error): the Web Egress Guard's refusals ("URL bloquée : …", "Délai dépassé (phase)").
function isClosedTableError(error) {
  return error instanceof EgressDeniedError || error instanceof EgressTimeoutError;
}

/** True when the message may reach the client as is: a PublicError or a closed-table Docteur error. */
export function hasTrustedMessage(error) {
  return isPublicError(error) || (isClosedTableError(error) && CODE_RE.test(String(error.code)));
}

/** The message of a PublicError, else the caller's fixed fallback text. */
export function publicErrorMessage(error, fallback = SAFE_INTERNAL_ERROR_MESSAGE) {
  return hasTrustedMessage(error) ? error.message : fallback;
}

/**
 * Client-facing view of any thrown value: { status, code, message, hint }. Only a PublicError keeps its own
 * message/code/status; anything else gets the fallback chosen by the caller (default 500 INTERNAL_ERROR).
 */
export function toSafePublicError(error, { code = 'INTERNAL_ERROR', message = SAFE_INTERNAL_ERROR_MESSAGE, status = 500, hint = null } = {}) {
  if (isPublicError(error)) return { status: error.status, code: error.code, message: error.message, hint: error.hint };
  if (hasTrustedMessage(error)) return { status: validStatus(status) ? status : 500, code: error.code, message: error.message, hint: null };
  return {
    status: validStatus(status) ? status : 500,
    code: CODE_RE.test(code) ? code : 'INTERNAL_ERROR',
    message: String(message),
    hint: typeof hint === 'string' ? hint : null,
  };
}

/** The `{ error: string, code, hint? }` body most routes (and the frontend) already use. */
export function publicErrorBody(error, fallback = {}) {
  const e = toSafePublicError(error, fallback);
  return e.hint ? { error: e.message, code: e.code, hint: e.hint } : { error: e.message, code: e.code };
}

/** Closed error code for logs / persistent stores: a PublicError code, a known system code, or null. */
export function safeErrorCode(error) {
  const c = error?.code;
  if (hasTrustedMessage(error)) return error.code;
  return typeof c === 'string' && SYSTEM_CODES.has(c) ? c : null;
}

function safeErrorClass(error) {
  const n = error?.constructor?.name;
  return typeof n === 'string' && CLASS_RE.test(n) ? n : null;
}

function safeHttpStatus(error) {
  const s = Number(error?.status_code ?? error?.statusCode ?? error?.status);
  return Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
}

/**
 * The ONLY fields to log / persist about an error that is not known to be trusted. Field names avoid logger.js
 * redacted paths (`code`, `key`, `token`…). Never message, stack, cause or body.
 */
export function safeErrorLogFields(error, { errorCode = null, operation = null } = {}) {
  return {
    errorCode: typeof errorCode === 'string' && CODE_RE.test(errorCode) ? errorCode : (isPublicError(error) ? error.code : 'UNCLASSIFIED_ERROR'),
    errorClass: safeErrorClass(error),
    sysCode: safeErrorCode(error),
    operation: typeof operation === 'string' && OPERATION_RE.test(operation) ? operation : null,
    category: safeErrorCategory(error),
    httpStatus: safeHttpStatus(error),
  };
}

/** Activity-log / store `reason`: a stable code, never the error text. */
export function safeErrorReason(error, fallback = 'INTERNAL_ERROR') {
  if (hasTrustedMessage(error)) return error.code;
  return CODE_RE.test(fallback) ? fallback : 'INTERNAL_ERROR';
}

/**
 * Hono `app.onError` boundary. HTTPException (Hono / app-built) keeps its own response; a PublicError keeps its
 * status/code/message; an unreachable model runtime stays a distinct 503; every other exception is 500 INTERNAL_ERROR.
 */
export function createSafeErrorHandler({ logger = null, isRuntimeUnavailable = () => false } = {}) {
  return (error, c) => {
    if (error instanceof HTTPException) {
      logger?.warn({ ...safeErrorLogFields(error, { errorCode: 'HTTP_EXCEPTION', operation: 'http.on_error' }), httpStatus: error.status, method: c.req.method, path: c.req.path }, 'request error');
      return error.getResponse();
    }
    let runtimeDown = false;
    try { runtimeDown = !isPublicError(error) && isRuntimeUnavailable(error) === true; } catch { runtimeDown = false; }
    const e = runtimeDown
      ? toSafePublicError(error, { code: 'MODEL_RUNTIME_UNAVAILABLE', message: SAFE_RUNTIME_UNAVAILABLE_MESSAGE, status: 503 })
      : toSafePublicError(error);
    logger?.error({ ...safeErrorLogFields(error, { errorCode: e.code, operation: 'http.on_error' }), status: e.status, method: c.req.method, path: c.req.path }, 'request error');
    return c.json(e.hint ? { error: e.message, code: e.code, hint: e.hint } : { error: e.message, code: e.code }, e.status);
  };
}
