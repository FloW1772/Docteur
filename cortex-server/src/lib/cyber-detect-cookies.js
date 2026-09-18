/**
 * Cookie attribute detector (CA-4, priority 3). PURE function — takes an
 * already-fetched Set-Cookie header value (or array of values) and
 * returns findings about the cookie's ATTRIBUTES only. The cookie VALUE
 * is never inspected/compared here and never included in a finding's
 * `observed` text raw — callers must pass evidence through
 * cyber-redact.js's redactCookieHeaderValue() before persisting, and this
 * module itself never echoes a full raw cookie string back into a finding
 * (only the cookie NAME + parsed attributes).
 */

import { finding } from './cyber-finding.js';

function parseSetCookie(raw) {
  const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
  const [nameValue, ...attrParts] = parts;
  const eq = nameValue.indexOf('=');
  const name = eq === -1 ? nameValue : nameValue.slice(0, eq);
  const attributes = { secure: false, httpOnly: false, sameSite: null, domain: null, path: null, expires: null, maxAge: null };
  for (const attr of attrParts) {
    const [rawKey, rawVal] = attr.split('=').map(s => s?.trim());
    const key = rawKey.toLowerCase();
    if (key === 'secure') attributes.secure = true;
    else if (key === 'httponly') attributes.httpOnly = true;
    else if (key === 'samesite') attributes.sameSite = rawVal || null;
    else if (key === 'domain') attributes.domain = rawVal || null;
    else if (key === 'path') attributes.path = rawVal || null;
    else if (key === 'expires') attributes.expires = rawVal || null;
    else if (key === 'max-age') attributes.maxAge = rawVal ? Number(rawVal) : null;
  }
  return { name, ...attributes };
}

const SESSION_LIKE_NAME = /(session|sess|auth|token|jwt|login|user)/i;

export function detectCookies({ setCookieHeader, isHttps, asset }) {
  if (!setCookieHeader) return [];
  const raws = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const findings = [];

  for (const raw of raws) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const cookie = parseSetCookie(raw);
    if (!cookie.name) continue;

    // Secure — only meaningful to require over HTTPS (over plain HTTP the
    // browser will reject a Secure cookie anyway, so absence is expected).
    if (isHttps && !cookie.secure) {
      findings.push(finding({
        id: `cookie-missing-secure-${cookie.name}`,
        title: `Cookie "${cookie.name}" sans attribut Secure`,
        category: 'cookies',
        severity: SESSION_LIKE_NAME.test(cookie.name) ? 'MEDIUM' : 'LOW',
        confidence: 'HIGH',
        asset,
        observed: `Le cookie "${cookie.name}" est posé sur une réponse HTTPS sans l'attribut Secure.`,
        interpretation: 'Un cookie sans Secure peut être transmis en clair si l\'utilisateur accède au même domaine en HTTP, exposant sa valeur en cas d\'interception réseau.',
        recommendation: `Ajouter l'attribut Secure au cookie "${cookie.name}".`,
      }));
    }

    // HttpOnly — most relevant for session/auth-like cookie names, but
    // reported (lower severity) for any cookie since any cookie readable
    // by JS increases XSS impact.
    if (!cookie.httpOnly) {
      findings.push(finding({
        id: `cookie-missing-httponly-${cookie.name}`,
        title: `Cookie "${cookie.name}" sans attribut HttpOnly`,
        category: 'cookies',
        severity: SESSION_LIKE_NAME.test(cookie.name) ? 'MEDIUM' : 'LOW',
        confidence: 'HIGH',
        asset,
        observed: `Le cookie "${cookie.name}" ne porte pas l'attribut HttpOnly.`,
        interpretation: 'Un cookie sans HttpOnly est lisible par du JavaScript côté client — en cas de faille XSS, ce cookie pourrait être exfiltré.',
        recommendation: `Ajouter l'attribut HttpOnly au cookie "${cookie.name}" s'il n'a pas besoin d'être lu par du JavaScript.`,
      }));
    }

    // SameSite
    if (!cookie.sameSite) {
      findings.push(finding({
        id: `cookie-missing-samesite-${cookie.name}`,
        title: `Cookie "${cookie.name}" sans attribut SameSite`,
        category: 'cookies',
        severity: 'LOW',
        confidence: 'HIGH',
        asset,
        observed: `Le cookie "${cookie.name}" ne précise pas d'attribut SameSite.`,
        interpretation: 'Le comportement par défaut dépend du navigateur ; l\'absence d\'un SameSite explicite peut faciliter certains scénarios de requêtes intersites non désirées (CSRF).',
        recommendation: `Définir explicitement SameSite=Lax ou Strict pour "${cookie.name}", selon le besoin fonctionnel.`,
      }));
    } else if (cookie.sameSite.toLowerCase() === 'none' && !cookie.secure) {
      // SameSite=None requires Secure per the spec — browsers reject it
      // otherwise, so this is a functional misconfiguration, not merely
      // a hardening suggestion.
      findings.push(finding({
        id: `cookie-samesite-none-without-secure-${cookie.name}`,
        title: `Cookie "${cookie.name}" avec SameSite=None sans Secure`,
        category: 'cookies',
        severity: 'LOW',
        confidence: 'HIGH',
        asset,
        observed: `Le cookie "${cookie.name}" porte SameSite=None sans l'attribut Secure.`,
        interpretation: 'Les navigateurs modernes exigent Secure avec SameSite=None ; ce cookie risque d\'être rejeté silencieusement par le client.',
        recommendation: `Ajouter Secure au cookie "${cookie.name}", requis par la spécification pour SameSite=None.`,
      }));
    }

    // No expiry at all is informational, not a weakness by itself.
    if (!cookie.expires && cookie.maxAge === null) {
      findings.push(finding({
        id: `cookie-session-only-${cookie.name}`,
        title: `Cookie "${cookie.name}" sans expiration explicite (cookie de session)`,
        category: 'cookies',
        severity: 'INFO',
        confidence: 'HIGH',
        asset,
        observed: `Le cookie "${cookie.name}" ne définit ni Expires ni Max-Age.`,
        interpretation: 'Ce cookie expirera à la fermeture du navigateur — comportement normal pour un cookie de session, à vérifier si ce n\'est pas l\'intention.',
        recommendation: 'Aucune action requise si ce comportement est voulu.',
      }));
    }
  }

  return findings;
}
