/**
 * TLS/certificate detector (CA-4, priority 1). PURE function — takes the
 * already-captured result of cyber-gateway.js's safeCyberTlsInspect() and
 * returns findings. Never opens a socket itself, never a mock TLS
 * connection is created here — this module is unit-tested against
 * hand-built fixture objects shaped exactly like safeCyberTlsInspect's
 * real return value, per the mission's explicit instruction to stay on
 * controlled mocks for the certificate/handshake part (no local cert
 * generation, no OpenSSL dependency).
 *
 * Observation only: a weak/expired/mismatched certificate or an old
 * protocol version is reported as a FINDING with a hedged interpretation,
 * never asserted as "vulnerable" — the target may have compensating
 * controls this detector cannot see (e.g. mTLS in front of it).
 */

import { finding } from './cyber-finding.js';

const WEAK_PROTOCOLS = new Set(['SSLv3', 'TLSv1', 'TLSv1.1']);
const MODERN_PROTOCOLS = new Set(['TLSv1.2', 'TLSv1.3']);

// Cipher names widely considered weak (export-grade, RC4, DES/3DES, NULL,
// anonymous Diffie-Hellman) — a small, explicit, well-known list, not a
// heuristic guess.
const WEAK_CIPHER_PATTERN = /(export|rc4|des|3des|null|anon|md5)/i;

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} tlsResult - the exact shape returned by safeCyberTlsInspect()
 * @param {string} asset - the hostname[:port] this result describes, for the finding's `asset` field
 * @param {Date} now - injectable clock for deterministic expiry tests
 */
export function detectTls(tlsResult, asset, now = new Date()) {
  const findings = [];

  if (!tlsResult) {
    findings.push(finding({
      id: 'tls-unreachable',
      title: 'Connexion TLS impossible',
      category: 'tls',
      severity: 'INFO',
      confidence: 'HIGH',
      asset,
      observed: 'La tentative de handshake TLS n\'a produit aucun résultat exploitable.',
      interpretation: 'Le service n\'écoute peut-être pas en HTTPS sur ce port, ou a refusé la connexion avant le handshake.',
      recommendation: 'Vérifier manuellement que le port/protocole visé est correct.',
    }));
    return findings;
  }

  // ── Certificate validity: expired / not-yet-valid / expiring soon ──
  if (tlsResult.certificate?.validTo) {
    const validTo = new Date(tlsResult.certificate.validTo);
    if (!Number.isNaN(validTo.getTime())) {
      const days = daysBetween(now, validTo);
      if (days < 0) {
        findings.push(finding({
          id: 'tls-cert-expired',
          title: 'Certificat TLS expiré',
          category: 'tls',
          severity: 'HIGH',
          confidence: 'HIGH',
          asset,
          observed: `Le certificat a expiré le ${tlsResult.certificate.validTo} (il y a ${-days} jour(s)).`,
          interpretation: 'Les navigateurs et clients modernes refuseront ou avertiront fortement sur cette connexion.',
          recommendation: 'Renouveler le certificat TLS dès que possible.',
        }));
      } else if (days <= 14) {
        findings.push(finding({
          id: 'tls-cert-expiring-soon',
          title: 'Certificat TLS bientôt expiré',
          category: 'tls',
          severity: 'MEDIUM',
          confidence: 'HIGH',
          asset,
          observed: `Le certificat expire le ${tlsResult.certificate.validTo} (dans ${days} jour(s)).`,
          interpretation: 'Un renouvellement tardif entraînerait une interruption de service en HTTPS.',
          recommendation: 'Planifier le renouvellement du certificat avant cette date.',
        }));
      }
    }
    if (tlsResult.certificate.validFrom) {
      const validFrom = new Date(tlsResult.certificate.validFrom);
      if (!Number.isNaN(validFrom.getTime()) && validFrom.getTime() > now.getTime()) {
        findings.push(finding({
          id: 'tls-cert-not-yet-valid',
          title: 'Certificat TLS pas encore valide',
          category: 'tls',
          severity: 'MEDIUM',
          confidence: 'HIGH',
          asset,
          observed: `Le certificat n'est valide qu'à partir du ${tlsResult.certificate.validFrom}.`,
          interpretation: 'Peut indiquer une erreur de configuration (horloge serveur, mauvais certificat déployé).',
          recommendation: 'Vérifier la date système du serveur et le certificat effectivement déployé.',
        }));
      }
    }
  }

  // ── Hostname / authorization mismatch (as reported by Node's own TLS
  //    verification — we surface it, we don't re-implement hostname
  //    matching ourselves, since that would risk a second, divergent
  //    implementation of a security-critical check). ──
  if (tlsResult.authorized === false) {
    findings.push(finding({
      id: 'tls-not-authorized',
      title: 'Certificat TLS non validé par la chaîne de confiance standard',
      category: 'tls',
      severity: 'HIGH',
      confidence: 'MEDIUM', // MEDIUM: could be self-signed-by-design (internal tool) rather than a real gap
      asset,
      observed: `La vérification TLS standard a échoué : ${tlsResult.authorizationError || 'raison non précisée'}.`,
      interpretation: 'Le certificat peut être auto-signé, expiré, ou émis pour un autre nom d\'hôte — un navigateur affichera un avertissement.',
      recommendation: 'Déployer un certificat émis par une autorité reconnue et couvrant le bon nom d\'hôte, sauf si l\'auto-signature est un choix assumé pour un usage interne.',
    }));
  }

  // ── Protocol version ──
  if (tlsResult.protocol) {
    if (WEAK_PROTOCOLS.has(tlsResult.protocol)) {
      findings.push(finding({
        id: 'tls-weak-protocol',
        title: `Protocole TLS obsolète négocié (${tlsResult.protocol})`,
        category: 'tls',
        severity: tlsResult.protocol === 'SSLv3' ? 'HIGH' : 'MEDIUM',
        confidence: 'HIGH',
        asset,
        observed: `Le serveur a négocié ${tlsResult.protocol} lors du handshake observé.`,
        interpretation: 'Les versions antérieures à TLS 1.2 sont dépréciées par les principales autorités (NIST, PCI-DSS) et les navigateurs modernes.',
        recommendation: 'Désactiver les versions de protocole antérieures à TLS 1.2 côté serveur.',
      }));
    } else if (!MODERN_PROTOCOLS.has(tlsResult.protocol)) {
      findings.push(finding({
        id: 'tls-unknown-protocol',
        title: `Protocole TLS non reconnu (${tlsResult.protocol})`,
        category: 'tls',
        severity: 'LOW',
        confidence: 'LOW',
        asset,
        observed: `Protocole négocié : ${tlsResult.protocol}.`,
        interpretation: 'Valeur inattendue — à vérifier manuellement.',
        recommendation: 'Confirmer manuellement la configuration TLS du serveur.',
      }));
    }
  }

  // ── Cipher suite ──
  const cipherName = tlsResult.cipher?.name;
  if (cipherName && WEAK_CIPHER_PATTERN.test(cipherName)) {
    findings.push(finding({
      id: 'tls-weak-cipher',
      title: `Suite cryptographique faible négociée (${cipherName})`,
      category: 'tls',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      asset,
      observed: `Cipher négocié : ${cipherName}.`,
      interpretation: 'Cette suite cryptographique est considérée faible ou obsolète par les recommandations actuelles.',
      recommendation: 'Restreindre la configuration serveur aux suites cryptographiques modernes (AEAD, sans RC4/DES/export/anon/MD5).',
    }));
  }

  return findings;
}
