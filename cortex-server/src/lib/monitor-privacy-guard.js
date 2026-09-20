/**
 * Observateur passive monitoring — privacy guard. The single choke point
 * every collector sample MUST pass through before it ever reaches
 * monitor-aggregator.js / sqlite.js. Strips anything that isn't on the
 * explicit metadata allowlist, so no code path can accidentally persist
 * a password, cookie, token, Authorization header, form field, message
 * body, or HTTPS payload — those are simply not fields this function
 * knows how to copy out.
 *
 * HOW TO EXTEND: add a new metadata field ONLY to ALLOWED_CONNECTION_FIELDS
 * (or ALLOWED_PROCESS_FIELDS) below, never by loosening the copy logic
 * into a generic spread of the input object.
 */

const ALLOWED_CONNECTION_FIELDS = [
  'processName', 'pid', 'remoteAddress', 'remotePort', 'localPort',
  'protocol', 'state', 'timestamp', 'approxBytes',
];

const ALLOWED_PROCESS_FIELDS = ['processName', 'pid', 'timestamp'];

function pick(input, allowedFields) {
  const out = {};
  for (const field of allowedFields) {
    if (input && Object.prototype.hasOwnProperty.call(input, field)) {
      out[field] = input[field];
    }
  }
  return out;
}

export function sanitizeConnection(raw) {
  return pick(raw, ALLOWED_CONNECTION_FIELDS);
}

export function sanitizeProcess(raw) {
  return pick(raw, ALLOWED_PROCESS_FIELDS);
}

export function sanitizeSnapshot(snapshot) {
  return {
    connections: (snapshot?.connections ?? []).map(sanitizeConnection),
    processes: (snapshot?.processes ?? []).map(sanitizeProcess),
  };
}
