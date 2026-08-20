/**
 * SSRF protection — rejects URLs that target private/internal network addresses.
 * Checks the hostname as supplied (no async DNS resolution, so DNS rebinding
 * is out of scope for this local tool). Covers the main attack vectors:
 * localhost, IPv4 private ranges, IPv6 loopback.
 */

function isInternalHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Named loopback / link-local
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0') return true;

  // IPv6 loopback & link-local
  if (h === '::1' || h.startsWith('fc00:') || h.startsWith('fe80:') || h.startsWith('fd')) return true;

  // IPv4 — check private ranges
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0)   return true;  // 0.x.x.x
    if (a === 127) return true;  // 127.x.x.x (loopback)
    if (a === 10)  return true;  // 10.x.x.x
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16–31.x
    if (a === 192 && b === 168) return true;            // 192.168.x.x
    if (a === 169 && b === 254) return true;            // 169.254.x.x (link-local)
  }

  return false;
}

/**
 * Throws an Error if the URL targets an internal / private address.
 * Call this before any outbound HTTP request triggered by user input.
 */
export function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('URL invalide'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Protocole non autorisé (http/https uniquement)');
  }

  if (isInternalHost(parsed.hostname)) {
    throw new Error('URL bloquée : les adresses internes ne sont pas autorisées');
  }
}
