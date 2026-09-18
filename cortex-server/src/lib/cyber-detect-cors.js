/**
 * CORS policy detector (CA-4, priority 4). PURE function — takes the
 * already-captured result of cyber-gateway.js's safeCyberCorsProbe()
 * (an OPTIONS request with a synthetic cross-origin Origin header) and
 * returns findings. Never sends a request itself.
 *
 * Distinguishes a broad-but-explicit wildcard ("Access-Control-Allow-Origin: *")
 * from origin REFLECTION (the server echoes back whatever Origin it
 * receives) — reflection combined with allow-credentials is a materially
 * more serious finding than a bare wildcard (wildcard + credentials is
 * actually disallowed by the CORS spec and browsers will reject it,
 * whereas reflection + credentials is a real, spec-compliant, exploitable
 * pattern browsers will honor).
 */

import { finding } from './cyber-finding.js';

function firstValue(headers, name) {
  const value = headers?.[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function detectCors({ headers, probeOrigin, asset }) {
  const findings = [];
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  const allowOrigin = firstValue(h, 'access-control-allow-origin');
  if (!allowOrigin) {
    // No CORS headers at all is the safe default — nothing to report.
    return findings;
  }

  const allowCredentials = firstValue(h, 'access-control-allow-credentials');
  const credentialsEnabled = typeof allowCredentials === 'string' && allowCredentials.toLowerCase() === 'true';
  const isWildcard = allowOrigin === '*';
  const isReflected = !isWildcard && allowOrigin === probeOrigin;

  if (isReflected && credentialsEnabled) {
    findings.push(finding({
      id: 'cors-reflected-origin-with-credentials',
      title: 'CORS : origine reflétée avec Access-Control-Allow-Credentials',
      category: 'cors',
      severity: 'HIGH',
      confidence: 'HIGH',
      asset,
      observed: `Une requête avec l'en-tête Origin "${probeOrigin}" (choisi arbitrairement par l'audit, non lié au site réel) a reçu en retour "Access-Control-Allow-Origin: ${allowOrigin}" et "Access-Control-Allow-Credentials: true".`,
      interpretation: 'Le serveur semble accepter et refléter n\'importe quelle origine tout en autorisant l\'envoi de cookies/identifiants — un site tiers malveillant pourrait potentiellement lire des réponses authentifiées depuis le navigateur d\'une victime.',
      recommendation: 'Restreindre Access-Control-Allow-Origin à une liste explicite d\'origines de confiance lorsque Access-Control-Allow-Credentials est activé ; ne jamais refléter l\'en-tête Origin sans validation.',
    }));
  } else if (isReflected) {
    findings.push(finding({
      id: 'cors-reflected-origin',
      title: 'CORS : origine reflétée sans validation apparente',
      category: 'cors',
      severity: 'MEDIUM',
      confidence: 'MEDIUM',
      asset,
      observed: `L'en-tête Origin envoyé ("${probeOrigin}") a été reflété tel quel dans Access-Control-Allow-Origin.`,
      interpretation: 'Sans identifiants (cookies), l\'impact direct est limité, mais ce comportement suggère l\'absence d\'une liste blanche d\'origines — à confirmer.',
      recommendation: 'Valider les origines autorisées via une liste explicite plutôt qu\'une réflexion systématique.',
    }));
  } else if (isWildcard && credentialsEnabled) {
    // Per the Fetch/CORS spec, browsers reject the combination of "*" with
    // allow-credentials — this is a server misconfiguration that will not
    // actually work in a compliant browser, so it's a lower-severity
    // finding than genuine reflection+credentials.
    findings.push(finding({
      id: 'cors-wildcard-with-credentials-header',
      title: 'CORS : wildcard combiné à Access-Control-Allow-Credentials (non conforme)',
      category: 'cors',
      severity: 'LOW',
      confidence: 'MEDIUM',
      asset,
      observed: 'Access-Control-Allow-Origin: * est envoyé conjointement à Access-Control-Allow-Credentials: true.',
      interpretation: 'Cette combinaison est rejetée par les navigateurs conformes aux spécifications CORS actuelles ; elle indique une configuration incohérente plutôt qu\'un risque immédiat exploitable via un navigateur standard.',
      recommendation: 'Corriger la configuration : soit restreindre l\'origine autorisée, soit retirer Access-Control-Allow-Credentials si un accès public est voulu.',
    }));
  } else if (isWildcard) {
    findings.push(finding({
      id: 'cors-wildcard-origin',
      title: 'CORS : origine autorisée en wildcard',
      category: 'cors',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: 'Access-Control-Allow-Origin: * est renvoyé, sans Access-Control-Allow-Credentials.',
      interpretation: 'Acceptable pour une ressource publique sans données sensibles ni session ; à vérifier si ce n\'est pas le cas ici.',
      recommendation: 'Confirmer que la ressource exposée ne contient aucune donnée sensible spécifique à un utilisateur.',
    }));
  }

  return findings;
}
