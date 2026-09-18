/**
 * Deterministic, self-contained HTML report generator for the Cyber
 * Audit Agent (SENTINEL V1, CA-9). Pure function of already-persisted
 * mission/scope/findings/evidence data — never performs network I/O,
 * never re-runs detectors, never calls the crawler or gateway.
 *
 * XSS is the load-bearing threat model here: every piece of text that
 * ultimately came from the AUDITED TARGET (a finding's observed text,
 * an evidence excerpt/header value, an asset URL) is untrusted external
 * data and is HTML-escaped before being placed into the document. There
 * is exactly one escaping function (escapeHtml) and every interpolation
 * site in this file goes through it or through a small number of
 * higher-level helpers that themselves call it — no ad hoc
 * string-concatenation of unescaped target-derived text anywhere.
 *
 * Defense in depth: evidence is re-redacted here via cyber-redact.js's
 * deepRedactEvidence/redactHeaders even though cyber-evidence.js already
 * redacted it at persistence time (CA-5) — a report generator must never
 * assume an upstream redaction pass was correct, per the mission's
 * explicit "même si CA-5 a déjà redacted" instruction.
 *
 * No JavaScript in the generated document (V1 requirement) — no
 * <script>, no inline event handlers, no external stylesheet/script,
 * only an embedded <style> block. No CDN, no external asset.
 */

import { deepRedactEvidence, redactHeaders } from './cyber-redact.js';

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatDate(iso) {
  if (!iso) return 'N/A';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return escapeHtml(iso);
  }
}

function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 'N/A';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'N/A';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

function severityClass(severity) {
  return `sev-${String(severity || 'INFO').toLowerCase()}`;
}

function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]));
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  }
  return counts;
}

function sortFindingsBySeverity(findings) {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

// ---------------------------------------------------------------------
// Section builders — each returns an HTML fragment string. Every
// target-derived value passed through escapeHtml/escapeAttr.
// ---------------------------------------------------------------------

function buildCover(mission) {
  return `
    <section class="cover">
      <h1>Rapport d'audit de sécurité externe</h1>
      <p class="cover-subtitle">SENTINEL V1 — Cyber Audit Agent</p>
      <table class="cover-meta">
        <tr><th>Mission</th><td>${escapeHtml(mission.title)}</td></tr>
        <tr><th>Client</th><td>${escapeHtml(mission.clientName)}</td></tr>
        <tr><th>Date de génération</th><td>${escapeHtml(new Date().toISOString())}</td></tr>
        <tr><th>Statut de la mission</th><td>${escapeHtml(mission.status)}</td></tr>
      </table>
    </section>`;
}

function buildMissionInfo(mission) {
  return `
    <section>
      <h2>Informations sur la mission</h2>
      <table class="kv-table">
        <tr><th>Identifiant</th><td>${escapeHtml(mission.id)}</td></tr>
        <tr><th>Titre</th><td>${escapeHtml(mission.title)}</td></tr>
        <tr><th>Client</th><td>${escapeHtml(mission.clientName)}</td></tr>
        <tr><th>Mode</th><td>${escapeHtml(mission.mode)}</td></tr>
        <tr><th>Créée le</th><td>${formatDate(mission.createdAt)}</td></tr>
        <tr><th>Démarrée le</th><td>${formatDate(mission.startedAt)}</td></tr>
        <tr><th>Terminée le</th><td>${formatDate(mission.completedAt)}</td></tr>
        <tr><th>Durée</th><td>${escapeHtml(formatDuration(mission.startedAt, mission.completedAt))}</td></tr>
      </table>
    </section>`;
}

function buildAuthorizationStatement(mission) {
  return `
    <section>
      <h2>Déclaration d'autorisation</h2>
      <p>Cette mission a été créée avec une confirmation explicite d'autorisation
      (authorizationConfirmed = true) et une référence d'autorisation associée.
      Aucun audit SENTINEL ne peut démarrer sans cette confirmation.</p>
      <table class="kv-table">
        <tr><th>Autorisation confirmée</th><td>${mission.authorizationConfirmed !== false ? 'Oui' : 'Non'}</td></tr>
        <tr><th>Référence d'autorisation</th><td>${escapeHtml(mission.authorizationReference || 'N/A')}</td></tr>
      </table>
    </section>`;
}

function buildScope(mission) {
  const scope = mission.scope || {};
  const list = (arr) => Array.isArray(arr) && arr.length ? arr.map(v => `<li>${escapeHtml(v)}</li>`).join('') : '<li>(aucun)</li>';
  return `
    <section>
      <h2>Périmètre autorisé (scope)</h2>
      <table class="kv-table">
        <tr><th>Hôtes autorisés</th><td><ul>${list(scope.allowedHosts)}</ul></td></tr>
        <tr><th>Ports autorisés</th><td><ul>${list(scope.allowedPorts)}</ul></td></tr>
        <tr><th>Protocoles autorisés</th><td><ul>${list(scope.allowedProtocols)}</ul></td></tr>
        <tr><th>Profondeur maximale</th><td>${escapeHtml(scope.maxDepth ?? 'N/A')}</td></tr>
        <tr><th>Requêtes maximales</th><td>${escapeHtml(scope.maxRequests ?? 'N/A')}</td></tr>
      </table>
    </section>`;
}

function buildMethodology() {
  return `
    <section>
      <h2>Méthodologie</h2>
      <p>SENTINEL V1 effectue un audit externe, automatisé, autorisé et non
      destructif, limité aux méthodes HTTP GET/HEAD/OPTIONS. La découverte de
      pages est bornée au périmètre déclaré (liens réels trouvés dans des
      pages déjà autorisées, robots.txt et sitemap.xml lorsqu'autorisés) —
      aucune génération de chemins, aucun brute force, aucun scan de ports,
      aucune énumération de sous-domaines. Les vérifications portent sur :
      la configuration TLS, les en-têtes de sécurité HTTP, les attributs de
      cookies, la configuration CORS, et les signaux de divulgation
      d'information observables passivement. Le débit de requêtes est
      limité (rate limiting appliqué), et chaque requête réseau est validée
      contre le périmètre avant envoi.</p>
    </section>`;
}

function buildLimitations() {
  return `
    <section>
      <h2>Limitations</h2>
      <ul>
        <li>Cet audit ne constitue pas un test d'intrusion complet.</li>
        <li>Aucune exploitation, aucun contournement d'authentification, aucun brute force n'a été tenté.</li>
        <li>Aucun scan de ports n'a été effectué.</li>
        <li>L'audit est non authentifié — les zones nécessitant une connexion n'ont pas été testées.</li>
        <li>La découverte de pages est bornée au périmètre déclaré et aux liens réellement présents dans les pages autorisées.</li>
        <li><strong>L'absence de vulnérabilité détectée ne signifie pas absence de vulnérabilité.</strong></li>
        <li>Cet audit V1 est externe, automatisé, autorisé et non destructif.</li>
      </ul>
    </section>`;
}

function buildExecutiveSummary(mission, findings) {
  const counts = countBySeverity(findings);
  const highest = SEVERITY_ORDER.find(s => counts[s] > 0) || 'INFO';
  const priority = sortFindingsBySeverity(findings).slice(0, 5);
  const findingsList = findings.length
    ? `<ul>${priority.map(f => `<li>[${escapeHtml(f.severity)}] ${escapeHtml(f.title)} — ${escapeHtml(f.asset)}</li>`).join('')}</ul>`
    : `<p>Aucun autre problème n'a été détecté dans le périmètre et avec la méthodologie de cet audit.</p>`;
  return `
    <section>
      <h2>Résumé exécutif</h2>
      <table class="kv-table">
        <tr><th>Périmètre</th><td>${escapeHtml((mission.scope?.allowedHosts || []).join(', ') || 'N/A')}</td></tr>
        <tr><th>Date</th><td>${formatDate(mission.completedAt || mission.startedAt)}</td></tr>
        <tr><th>Niveau de risque observé le plus élevé</th><td>${escapeHtml(highest)}</td></tr>
      </table>
      <h3>Principaux constats</h3>
      ${findingsList}
      <h3>Actions prioritaires</h3>
      ${findings.length ? `<p>Voir la section Recommandations pour le détail par constat, en commençant par les éléments de sévérité la plus élevée.</p>` : `<p>Aucune action corrective prioritaire identifiée dans le périmètre audité.</p>`}
      <h3>Limitations</h3>
      <p>Voir la section Limitations pour le détail complet des limites méthodologiques de cet audit.</p>
    </section>`;
}

function buildDisclaimer() {
  return `
    <section class="disclaimer">
      <h2>Avertissement</h2>
      <p><strong>L'absence de vulnérabilité détectée ne signifie pas absence de vulnérabilité.</strong></p>
      <p><strong>Cet audit V1 est externe, automatisé, autorisé et non destructif.</strong></p>
    </section>`;
}

function buildRiskDistribution(findings) {
  const counts = countBySeverity(findings);
  const rows = SEVERITY_ORDER.map(s => `<tr><th class="${severityClass(s)}">${s}</th><td>${counts[s]}</td></tr>`).join('');
  return `
    <section>
      <h2>Répartition des risques</h2>
      <table class="kv-table risk-table">${rows}</table>
    </section>`;
}

function buildFindingCard(finding, evidenceById) {
  const evidenceRows = (finding.evidenceIds || [])
    .map(id => evidenceById.get(id))
    .filter(Boolean)
    .map(ev => buildEvidenceRow(ev))
    .join('');
  return `
    <article class="finding-card ${severityClass(finding.severity)}">
      <header>
        <span class="badge ${severityClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
        <span class="badge badge-confidence">Confiance : ${escapeHtml(finding.confidence)}</span>
        <span class="badge badge-status">${escapeHtml(finding.status)}</span>
        <h3>${escapeHtml(finding.title)}</h3>
      </header>
      <table class="kv-table finding-meta">
        <tr><th>Actif (WHERE)</th><td>${escapeHtml(finding.asset)}</td></tr>
        <tr><th>Catégorie</th><td>${escapeHtml(finding.category)}</td></tr>
      </table>
      <div class="finding-section finding-observed">
        <h4>OBSERVÉ (WHAT)</h4>
        <p>${escapeHtml(finding.description)}</p>
      </div>
      <div class="finding-section finding-interpretation">
        <h4>INTERPRÉTATION (WHY IT MATTERS)</h4>
        <p>${escapeHtml(finding.impact || 'N/A')}</p>
      </div>
      <div class="finding-section finding-recommendation">
        <h4>RECOMMANDATION (HOW TO FIX)</h4>
        <p>${escapeHtml(finding.recommendation || 'N/A')}</p>
      </div>
      ${finding.references && finding.references.length ? `
      <div class="finding-section">
        <h4>Références</h4>
        <ul>${finding.references.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>` : ''}
      ${evidenceRows ? `
      <div class="finding-section">
        <h4>Preuve (EVIDENCE)</h4>
        <table class="kv-table evidence-table">${evidenceRows}</table>
      </div>` : ''}
    </article>`;
}

function buildFindings(findings, evidenceById) {
  if (!findings.length) {
    return `
      <section>
        <h2>Constats (findings)</h2>
        <p>Aucun autre problème n'a été détecté dans le périmètre et avec la méthodologie de cet audit.</p>
      </section>`;
  }
  const sorted = sortFindingsBySeverity(findings);
  return `
    <section>
      <h2>Constats (findings)</h2>
      ${sorted.map(f => buildFindingCard(f, evidenceById)).join('')}
    </section>`;
}

function buildEvidenceRow(evidence) {
  // Defense in depth: re-redact even though CA-5 already redacted at
  // persistence time — never trust an upstream pass silently.
  const redactedHeaders = redactHeaders(evidence.relevantHeaders || {});
  const redactedExcerpt = deepRedactEvidence(evidence.excerpt || '');
  const headerLines = Object.entries(redactedHeaders)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`)
    .join('\n');
  return `
    <tr><th>URL</th><td>${escapeHtml(evidence.url)}</td></tr>
    <tr><th>Méthode</th><td>${escapeHtml(evidence.method)}</td></tr>
    <tr><th>Horodatage</th><td>${formatDate(evidence.timestamp)}</td></tr>
    <tr><th>Statut de réponse</th><td>${escapeHtml(evidence.responseStatus ?? 'N/A')}</td></tr>
    <tr><th>En-têtes pertinents</th><td><pre>${escapeHtml(headerLines)}</pre></td></tr>
    <tr><th>Extrait</th><td><pre>${escapeHtml(redactedExcerpt)}</pre></td></tr>
    <tr><th>SHA-256</th><td><code>${escapeHtml(evidence.sha256)}</code></td></tr>`;
}

function buildEvidenceAppendix(evidence) {
  if (!evidence.length) {
    return `<section><h2>Preuves (evidence)</h2><p>Aucune preuve enregistrée.</p></section>`;
  }
  return `
    <section>
      <h2>Preuves (evidence)</h2>
      ${evidence.map(ev => `<table class="kv-table evidence-table">${buildEvidenceRow(ev)}</table>`).join('<hr class="evidence-sep" />')}
    </section>`;
}

const PRIORITY_RULE = 'Priorité = fonction de la sévérité du constat et de la confiance associée : CRITICAL/HIGH avec confiance HIGH ou MEDIUM => Quick Win ; MEDIUM, ou HIGH avec confiance LOW => Court terme ; LOW/INFO => Long terme. Cette règle est explicite et déterministe, jamais une priorité opaque calculée autrement.';

function priorityGroup(finding) {
  if (['CRITICAL', 'HIGH'].includes(finding.severity) && ['HIGH', 'MEDIUM'].includes(finding.confidence)) return 'QUICK_WINS';
  if (finding.severity === 'MEDIUM' || (finding.severity === 'HIGH' && finding.confidence === 'LOW')) return 'SHORT_TERM';
  return 'LONG_TERM';
}

function buildRecommendations(findings) {
  const groups = { QUICK_WINS: [], SHORT_TERM: [], LONG_TERM: [] };
  for (const f of findings) groups[priorityGroup(f)].push(f);
  const renderGroup = (label, items) => `
    <div class="remediation-group">
      <h3>${label}</h3>
      ${items.length ? `<ul>${items.map(f => `<li><strong>${escapeHtml(f.title)}</strong> (${escapeHtml(f.asset)}) — ${escapeHtml(f.recommendation || 'N/A')}</li>`).join('')}</ul>` : '<p>Aucun élément.</p>'}
    </div>`;
  return `
    <section>
      <h2>Recommandations</h2>
      <p class="priority-rule">${escapeHtml(PRIORITY_RULE)}</p>
      ${renderGroup('Quick Wins', groups.QUICK_WINS)}
      ${renderGroup('Court terme', groups.SHORT_TERM)}
      ${renderGroup('Long terme', groups.LONG_TERM)}
    </section>`;
}

function buildAppendix(mission, events) {
  const rows = (events || []).map(e => `<tr><td>${formatDate(e.createdAt)}</td><td>${escapeHtml(e.fromStatus || '—')}</td><td>${escapeHtml(e.toStatus)}</td></tr>`).join('');
  return `
    <section>
      <h2>Annexe — journal de la mission</h2>
      <table class="kv-table events-table">
        <thead><tr><th>Horodatage</th><th>De</th><th>Vers</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">Aucun évènement.</td></tr>'}</tbody>
      </table>
    </section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background: #f7f7f9; color: #1a1a1a; line-height: 1.5; }
  section { background: #fff; border: 1px solid #e2e2e6; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
  h1 { margin-top: 0; }
  .cover { text-align: center; }
  .cover-subtitle { color: #555; font-weight: 600; }
  table.kv-table { border-collapse: collapse; width: 100%; }
  table.kv-table th { text-align: left; padding: 6px 10px; width: 220px; vertical-align: top; color: #444; }
  table.kv-table td { padding: 6px 10px; }
  table.kv-table tr:nth-child(odd) { background: #fafafa; }
  .disclaimer { border: 2px solid #b45309; background: #fff8ec; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; margin-right: 6px; }
  .badge-confidence, .badge-status { background: #eee; color: #333; }
  .sev-critical { color: #7f1d1d; } .badge.sev-critical { background: #7f1d1d; color: #fff; }
  .sev-high { color: #b91c1c; } .badge.sev-high { background: #b91c1c; color: #fff; }
  .sev-medium { color: #b45309; } .badge.sev-medium { background: #b45309; color: #fff; }
  .sev-low { color: #1d4ed8; } .badge.sev-low { background: #1d4ed8; color: #fff; }
  .sev-info { color: #374151; } .badge.sev-info { background: #6b7280; color: #fff; }
  .finding-card { border: 1px solid #ddd; border-radius: 6px; padding: 14px 18px; margin-bottom: 16px; }
  .finding-section { margin-top: 10px; }
  .finding-section h4 { margin-bottom: 4px; }
  .finding-observed h4 { color: #1d4ed8; }
  .finding-interpretation h4 { color: #7c3aed; }
  .finding-recommendation h4 { color: #047857; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f3f3f5; padding: 8px; border-radius: 4px; }
  .remediation-group { margin-bottom: 14px; }
  .priority-rule { font-size: 13px; color: #555; font-style: italic; }
  .evidence-sep { border: none; border-top: 1px dashed #ccc; margin: 12px 0; }
`;

/**
 * Builds the complete, self-contained HTML report for one mission.
 * `mission`/`findings`/`evidence`/`events` are exactly the already-API
 * shaped objects cyber-orchestrator.js's getMission/getMissionFindings/
 * getAllMissionEvidence/getMissionEvents return — this function never
 * reaches into raw DB rows itself.
 */
export function generateMissionReport({ mission, findings, evidence, events }) {
  if (!mission || typeof mission !== 'object') throw new Error('report_mission_required');
  const findingsList = Array.isArray(findings) ? findings : [];
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const eventsList = Array.isArray(events) ? events : [];
  const evidenceById = new Map(evidenceList.map(e => [e.id, e]));

  const body = [
    buildCover(mission),
    buildMissionInfo(mission),
    buildAuthorizationStatement(mission),
    buildScope(mission),
    buildMethodology(),
    buildLimitations(),
    buildExecutiveSummary(mission, findingsList),
    buildDisclaimer(),
    buildRiskDistribution(findingsList),
    buildFindings(findingsList, evidenceById),
    buildEvidenceAppendix(evidenceList),
    buildRecommendations(findingsList),
    buildAppendix(mission, eventsList),
  ].join('\n');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(`Rapport d'audit — ${mission.title}`)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function generateFindingsJson({ mission, findings }) {
  return JSON.stringify({
    missionId: mission.id,
    title: mission.title,
    generatedAt: new Date().toISOString(),
    findings: (findings || []).map(f => ({
      id: f.id, title: f.title, category: f.category, severity: f.severity,
      confidence: f.confidence, status: f.status, asset: f.asset,
      description: f.description, impact: f.impact, recommendation: f.recommendation,
      references: f.references, firstSeen: f.firstSeen, lastSeen: f.lastSeen,
    })),
  }, null, 2);
}

export const __testing = { escapeHtml, escapeAttr, priorityGroup };
