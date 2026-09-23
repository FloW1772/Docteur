/**
 * OMEGA 4.1 transport policy.
 *
 * OMEGA data paths may use plain HTTP only on a loopback connection. Any
 * non-loopback request must arrive over a TLS socket. Forwarded headers are
 * deliberately ignored: the Node socket is the authoritative transport
 * boundary and there is no trusted reverse-proxy contract in V1.
 */

const LOOPBACK_ADDRESSES = new Set(['', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address ?? ''));
}

export function evaluateOmegaTransport({ remoteAddress = '', encrypted = false, socketAvailable = true } = {}) {
  // Hono's in-memory app.request() has no Node socket. That path is used for
  // unit/route tests and embedded callers; a real @hono/node-server request
  // always has a socket, so absence is not a LAN bypass in production.
  if (!socketAvailable) return { allowed: true, loopback: true, encrypted: false, reason: 'embedded' };

  const loopback = isLoopbackAddress(remoteAddress);
  const secure = encrypted === true;
  return {
    allowed: loopback || secure,
    loopback,
    encrypted: secure,
    reason: loopback ? 'loopback' : secure ? 'tls' : 'OMEGA_TLS_REQUIRED',
  };
}

export function getOmegaTransportInfo(c) {
  const incoming = c?.env?.incoming ?? c?.env?.server?.incoming;
  const socket = incoming?.socket;
  return evaluateOmegaTransport({
    remoteAddress: socket?.remoteAddress ?? '',
    encrypted: socket?.encrypted === true,
    socketAvailable: !!socket,
  });
}

export function isOmegaTransportAllowed(c) {
  return getOmegaTransportInfo(c).allowed;
}

export const OMEGA_TLS_REQUIRED = 'OMEGA_TLS_REQUIRED';

