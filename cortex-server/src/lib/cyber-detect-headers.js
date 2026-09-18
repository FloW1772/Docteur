/**
 * Security-header detector (CA-4, priority 2). PURE function — takes an
 * already-fetched headers object (lowercase keys, as returned by
 * cyber-gateway.js's safeCyberFetch) and the request's protocol, and
 * returns findings. Never fetches anything itself.
 *
 * Only observes/reports; never assumes intent. A missing header is always
 * LOW/MEDIUM severity with HIGH confidence (the absence itself is a hard
 * fact), never CRITICAL — a missing header alone is never proof of an
 * exploitable condition.
 */

import { finding } from './cyber-finding.js';

function firstValue(headers, name) {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function detectHeaders({ headers, isHttps, asset }) {
  const findings = [];
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  // ── HSTS — only meaningful over HTTPS; not applicable over plain HTTP. ──
  if (isHttps) {
    const hsts = firstValue(h, 'strict-transport-security');
    if (!hsts) {
      findings.push(finding({
        id: 'header-missing-hsts',
        title: 'En-tête Strict-Transport-Security absent',
        category: 'headers',
        severity: 'MEDIUM',
        confidence: 'HIGH',
        asset,
        observed: 'La réponse HTTPS ne contient pas d\'en-tête Strict-Transport-Security.',
        interpretation: 'Sans HSTS, un utilisateur tapant l\'URL en http:// (ou suivant un lien http://) peut être exposé à une interception avant la redirection vers HTTPS.',
        recommendation: 'Ajouter "Strict-Transport-Security: max-age=31536000; includeSubDomains" une fois HTTPS validé sur tout le périmètre.',
      }));
    } else if (!/max-age\s*=\s*\d+/i.test(hsts)) {
      findings.push(finding({
        id: 'header-hsts-malformed',
        title: 'En-tête Strict-Transport-Security mal formé',
        category: 'headers',
        severity: 'LOW',
        confidence: 'MEDIUM',
        asset,
        observed: `Valeur observée : "${hsts}".`,
        interpretation: 'Sans directive max-age valide, le navigateur peut ignorer l\'en-tête.',
        recommendation: 'Corriger la syntaxe de l\'en-tête HSTS (doit inclure max-age=<secondes>).',
      }));
    } else {
      const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(hsts);
      const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
      if (maxAge < 15552000) { // < 180 days
        findings.push(finding({
          id: 'header-hsts-short-max-age',
          title: 'Durée HSTS courte',
          category: 'headers',
          severity: 'LOW',
          confidence: 'MEDIUM',
          asset,
          observed: `max-age=${maxAge} secondes (~${Math.round(maxAge / 86400)} jours).`,
          interpretation: 'Une durée courte réduit la protection offerte entre deux visites de l\'utilisateur.',
          recommendation: 'Envisager une durée max-age d\'au moins 6 mois (15552000) une fois la configuration HTTPS stabilisée.',
        }));
      }
    }
  }

  // ── Content-Security-Policy ──
  const csp = firstValue(h, 'content-security-policy');
  if (!csp) {
    findings.push(finding({
      id: 'header-missing-csp',
      title: 'En-tête Content-Security-Policy absent',
      category: 'headers',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      asset,
      observed: 'La réponse ne contient pas d\'en-tête Content-Security-Policy.',
      interpretation: 'Sans CSP, le navigateur applique moins de restrictions par défaut sur les scripts/ressources chargés par la page — une des couches de défense contre le XSS est absente.',
      recommendation: 'Définir une politique CSP adaptée à l\'application (au minimum un default-src restrictif).',
    }));
  } else if (/(^|[\s;])default-src\s+[^;]*\*/.test(csp) || /unsafe-inline/.test(csp) || /unsafe-eval/.test(csp)) {
    findings.push(finding({
      id: 'header-weak-csp',
      title: 'Content-Security-Policy permissive',
      category: 'headers',
      severity: 'LOW',
      confidence: 'MEDIUM',
      asset,
      observed: `Politique observée : "${csp}".`,
      interpretation: 'Un default-src avec "*" ou l\'usage de unsafe-inline/unsafe-eval réduit fortement l\'efficacité de la CSP contre l\'injection de script.',
      recommendation: 'Restreindre les sources autorisées et éviter unsafe-inline/unsafe-eval si possible (utiliser des nonces/hashes).',
    }));
  }

  // ── X-Content-Type-Options ──
  const xcto = firstValue(h, 'x-content-type-options');
  if (!xcto || xcto.toLowerCase() !== 'nosniff') {
    findings.push(finding({
      id: 'header-missing-xcto',
      title: 'En-tête X-Content-Type-Options absent ou incorrect',
      category: 'headers',
      severity: 'LOW',
      confidence: 'HIGH',
      asset,
      observed: xcto ? `Valeur observée : "${xcto}".` : 'En-tête absent.',
      interpretation: 'Sans "nosniff", certains navigateurs peuvent essayer de deviner le type MIME d\'une ressource, ce qui peut être détourné dans certains scénarios.',
      recommendation: 'Ajouter "X-Content-Type-Options: nosniff".',
    }));
  }

  // ── Referrer-Policy ──
  if (!firstValue(h, 'referrer-policy')) {
    findings.push(finding({
      id: 'header-missing-referrer-policy',
      title: 'En-tête Referrer-Policy absent',
      category: 'headers',
      severity: 'LOW',
      confidence: 'HIGH',
      asset,
      observed: 'La réponse ne contient pas d\'en-tête Referrer-Policy.',
      interpretation: 'Le comportement de référence dépend alors du navigateur par défaut, ce qui peut divulguer plus d\'informations que nécessaire dans l\'en-tête Referer des requêtes sortantes.',
      recommendation: 'Ajouter une politique explicite, par exemple "Referrer-Policy: strict-origin-when-cross-origin".',
    }));
  }

  // ── Permissions-Policy ──
  if (!firstValue(h, 'permissions-policy')) {
    findings.push(finding({
      id: 'header-missing-permissions-policy',
      title: 'En-tête Permissions-Policy absent',
      category: 'headers',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: 'La réponse ne contient pas d\'en-tête Permissions-Policy.',
      interpretation: 'Les API sensibles du navigateur (caméra, micro, géolocalisation, etc.) ne sont pas explicitement restreintes au niveau de la réponse.',
      recommendation: 'Envisager de définir une politique de permissions adaptée aux besoins réels de la page.',
    }));
  }

  // ── X-Frame-Options (only meaningful if CSP doesn't already set
  //    frame-ancestors — both achieve clickjacking protection). ──
  const xfo = firstValue(h, 'x-frame-options');
  const cspHasFrameAncestors = csp && /frame-ancestors/i.test(csp);
  if (!xfo && !cspHasFrameAncestors) {
    findings.push(finding({
      id: 'header-missing-frame-protection',
      title: 'Aucune protection anti-clickjacking (X-Frame-Options / CSP frame-ancestors)',
      category: 'headers',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      asset,
      observed: 'Ni X-Frame-Options ni une directive CSP frame-ancestors ne sont présents.',
      interpretation: 'La page peut potentiellement être intégrée dans une iframe sur un site tiers, ouvrant la voie à des scénarios de clickjacking.',
      recommendation: 'Ajouter "X-Frame-Options: DENY" (ou SAMEORIGIN) ou une directive CSP "frame-ancestors" adaptée.',
    }));
  }

  // ── Cross-Origin isolation headers (COOP/CORP) ──
  if (!firstValue(h, 'cross-origin-opener-policy')) {
    findings.push(finding({
      id: 'header-missing-coop',
      title: 'En-tête Cross-Origin-Opener-Policy absent',
      category: 'headers',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: 'La réponse ne contient pas d\'en-tête Cross-Origin-Opener-Policy.',
      interpretation: 'Sans COOP, la page ne bénéficie pas de l\'isolation de fenêtre contre certaines attaques inter-origines (ex. side-channels).',
      recommendation: 'Envisager "Cross-Origin-Opener-Policy: same-origin" si l\'application n\'a pas besoin d\'interagir avec des fenêtres tierces.',
    }));
  }
  if (!firstValue(h, 'cross-origin-resource-policy')) {
    findings.push(finding({
      id: 'header-missing-corp',
      title: 'En-tête Cross-Origin-Resource-Policy absent',
      category: 'headers',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: 'La réponse ne contient pas d\'en-tête Cross-Origin-Resource-Policy.',
      interpretation: 'Sans CORP, la ressource peut être chargée depuis n\'importe quelle origine tierce (selon le contexte du navigateur).',
      recommendation: 'Envisager "Cross-Origin-Resource-Policy: same-origin" ou "same-site" selon le besoin réel de partage.',
    }));
  }

  return findings;
}
