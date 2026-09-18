/**
 * Information-disclosure detector (CA-4, priority 5). PURE function —
 * takes already-fetched response headers and a small HTML body excerpt
 * and returns findings about PUBLICLY-VISIBLE technology fingerprinting
 * signals only (Server/X-Powered-By headers, generator meta tags,
 * well-known framework headers). Never attempts active fingerprinting
 * (no probing multiple paths to infer a stack, no version-specific
 * payloads) — purely passive observation of what the target already
 * volunteered in this one response.
 *
 * A detected technology/version is reported as "réellement observé",
 * never elevated to a CVE claim — CVE correlation is explicitly out of
 * scope for this detector (CA-10 handles the OPTIONAL, hedged
 * "POTENTIALLY AFFECTED" framing separately, never here).
 */

import { finding } from './cyber-finding.js';

function firstValue(headers, name) {
  const value = headers?.[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

const GENERATOR_META_PATTERN = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i;

export function detectInfoDisclosure({ headers, bodyExcerpt, asset }) {
  const findings = [];
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  const server = firstValue(h, 'server');
  if (server && /\d/.test(server)) {
    // Only flag when a version-shaped number is present — a bare "Server:
    // nginx" with no version is a much weaker signal than "Apache/2.4.41".
    findings.push(finding({
      id: 'info-disclosure-server-header-version',
      title: 'En-tête Server révèle une version logicielle',
      category: 'info_disclosure',
      severity: 'LOW',
      confidence: 'HIGH',
      asset,
      observed: `En-tête Server observé : "${server}".`,
      interpretation: 'Révéler la version exacte du logiciel serveur facilite la recherche ciblée de failles connues pour cette version précise.',
      recommendation: 'Supprimer ou généraliser l\'en-tête Server (ne pas exposer le numéro de version) au niveau du serveur web/proxy.',
    }));
  } else if (server) {
    findings.push(finding({
      id: 'info-disclosure-server-header',
      title: 'En-tête Server présent',
      category: 'info_disclosure',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: `En-tête Server observé : "${server}".`,
      interpretation: 'Révèle la famille de logiciel serveur utilisée, sans numéro de version précis.',
      recommendation: 'Envisager de supprimer cet en-tête si aucune raison fonctionnelle ne le justifie.',
    }));
  }

  const poweredBy = firstValue(h, 'x-powered-by');
  if (poweredBy) {
    findings.push(finding({
      id: 'info-disclosure-x-powered-by',
      title: 'En-tête X-Powered-By présent',
      category: 'info_disclosure',
      severity: /\d/.test(poweredBy) ? 'LOW' : 'INFO',
      confidence: 'HIGH',
      asset,
      observed: `En-tête X-Powered-By observé : "${poweredBy}".`,
      interpretation: 'Révèle la technologie/le framework backend utilisé, ce qui facilite le ciblage de failles connues pour cette technologie.',
      recommendation: 'Supprimer l\'en-tête X-Powered-By côté serveur applicatif.',
    }));
  }

  if (typeof bodyExcerpt === 'string' && bodyExcerpt) {
    const generatorMatch = GENERATOR_META_PATTERN.exec(bodyExcerpt);
    if (generatorMatch) {
      const generator = generatorMatch[1];
      findings.push(finding({
        id: 'info-disclosure-generator-meta',
        title: 'Balise meta "generator" révèle la plateforme de contenu',
        category: 'info_disclosure',
        severity: /\d/.test(generator) ? 'LOW' : 'INFO',
        confidence: 'HIGH',
        asset,
        observed: `Balise meta generator observée : "${generator}".`,
        interpretation: 'Révèle le CMS/la plateforme (et parfois sa version), utile à un attaquant pour cibler des vulnérabilités connues de cette plateforme.',
        recommendation: 'Retirer ou vider la balise meta "generator" du HTML généré.',
      }));
    }
  }

  return findings;
}
