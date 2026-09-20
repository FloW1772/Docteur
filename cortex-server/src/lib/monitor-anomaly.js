/**
 * Observateur passive monitoring — deterministic anomaly rules. Every
 * rule is a pure function returning null or a candidate. No machine
 * learning, no opaque scoring, no rule may ever produce a severity
 * outside SEVERITIES below — in particular, nothing here may ever
 * declare "ATTAQUE"/"MALWARE"/"CONFIRMED_ATTACK". An anomaly is a
 * signal to review, never a verdict.
 */
import crypto from 'node:crypto';
import { getBaseline, isKnownDestination } from './monitor-baseline.js';
import { insertMonitorAnomaly } from './sqlite.js';

export const SEVERITIES = Object.freeze({
  OBSERVATION: 'OBSERVATION',
  SUSPICIOUS: 'SUSPICIOUS',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
});

// Docteur's own known outbound destinations — anything from a
// Docteur-tagged process NOT in this list is flagged by the
// new-external-destination-from-docteur-component rule. Kept small and
// explicit rather than inferred.
const DOCTEUR_KNOWN_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DOCTEUR_PROCESS_NAMES = new Set(['node.exe', 'node']);

const seenListeningPorts = new Set();
const seenProcessesWithNetwork = new Set();

function makeAnomaly({ ruleId, severity, processName, remoteAddress, description, evidenceRef }) {
  return {
    id: crypto.randomUUID(),
    ruleId,
    severity,
    processName: processName ?? null,
    remoteAddress: remoteAddress ?? null,
    description,
    evidenceRef: evidenceRef ?? {},
  };
}

function ruleNewUnusualDestination(conn, baseline) {
  if (!conn.remoteAddress || conn.state !== 'ESTABLISHED') return null;
  if (baseline.sampleCount === 0) return null; // no baseline yet — first sightings aren't anomalies
  if (isKnownDestination(baseline, conn.remoteAddress, conn.remotePort)) return null;
  return makeAnomaly({
    ruleId: 'new-unusual-destination',
    severity: SEVERITIES.OBSERVATION,
    processName: conn.processName,
    remoteAddress: conn.remoteAddress,
    description: `${conn.processName} contacte une nouvelle destination inhabituelle (${conn.remoteAddress}:${conn.remotePort ?? '?'}).`,
    evidenceRef: { remotePort: conn.remotePort, protocol: conn.protocol },
  });
}

function ruleNewListeningPort(conn) {
  if (conn.state !== 'LISTENING' || conn.localPort == null) return null;
  const key = `${conn.processName}:${conn.localPort}`;
  if (seenListeningPorts.has(key)) return null;
  seenListeningPorts.add(key);
  return makeAnomaly({
    ruleId: 'new-listening-port',
    severity: SEVERITIES.SUSPICIOUS,
    processName: conn.processName,
    description: `${conn.processName} écoute sur un nouveau port local (${conn.localPort}).`,
    evidenceRef: { localPort: conn.localPort, protocol: conn.protocol },
  });
}

function ruleNewProcessWithNetworkActivity(conn) {
  if (!conn.processName || conn.processName === 'processus inconnu') return null;
  if (seenProcessesWithNetwork.has(conn.processName)) return null;
  seenProcessesWithNetwork.add(conn.processName);
  return makeAnomaly({
    ruleId: 'new-process-with-network-activity',
    severity: SEVERITIES.OBSERVATION,
    processName: conn.processName,
    description: `${conn.processName} est observé avec une activité réseau pour la première fois.`,
    evidenceRef: {},
  });
}

function ruleVolumeAboveBaseline(conn, baseline) {
  if (baseline.sampleCount < 5 || baseline.avgBytesPerSample <= 0) return null;
  if (conn.approxBytes <= baseline.avgBytesPerSample * 5) return null;
  return makeAnomaly({
    ruleId: 'volume-above-baseline',
    severity: SEVERITIES.SUSPICIOUS,
    processName: conn.processName,
    remoteAddress: conn.remoteAddress,
    description: `${conn.processName} envoie un volume nettement supérieur à sa moyenne habituelle.`,
    evidenceRef: { approxBytes: conn.approxBytes, avgBytesPerSample: baseline.avgBytesPerSample },
  });
}

function ruleUnusualRepetitiveConnection(conn, sampleCount) {
  if (sampleCount < 50) return null; // same (process, dest) upserted 50+ times within the current window
  return makeAnomaly({
    ruleId: 'unusual-repetitive-connection',
    severity: SEVERITIES.SUSPICIOUS,
    processName: conn.processName,
    remoteAddress: conn.remoteAddress,
    description: `${conn.processName} se reconnecte de façon répétitive et inhabituelle vers ${conn.remoteAddress}.`,
    evidenceRef: { sampleCount },
  });
}

function ruleNewExternalDestinationFromDocteurComponent(conn) {
  if (!DOCTEUR_PROCESS_NAMES.has(conn.processName)) return null;
  if (!conn.remoteAddress || DOCTEUR_KNOWN_HOSTS.has(conn.remoteAddress)) return null;
  return makeAnomaly({
    ruleId: 'new-external-destination-from-docteur-component',
    severity: SEVERITIES.REQUIRES_REVIEW,
    processName: conn.processName,
    remoteAddress: conn.remoteAddress,
    description: `Un composant Docteur (${conn.processName}) contacte une destination externe non répertoriée (${conn.remoteAddress}).`,
    evidenceRef: { remotePort: conn.remotePort },
  });
}

// Runs every rule against one connection sample + its process baseline,
// persists any candidate, and stamps a security_signal on
// REQUIRES_REVIEW rows only — stored/displayed for a future MAITRE
// module to eventually consume, never emitted anywhere in V1.
export function evaluateConnection(conn, { sampleCount = 1 } = {}) {
  const baseline = getBaseline(conn.processName);
  const candidates = [
    ruleNewUnusualDestination(conn, baseline),
    ruleNewListeningPort(conn),
    ruleNewProcessWithNetworkActivity(conn),
    ruleVolumeAboveBaseline(conn, baseline),
    ruleUnusualRepetitiveConnection(conn, sampleCount),
    ruleNewExternalDestinationFromDocteurComponent(conn),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const securitySignal = candidate.severity === SEVERITIES.REQUIRES_REVIEW
      ? JSON.stringify({
          source: 'observateur',
          category: 'network',
          severity: candidate.severity,
          confidence: 'medium',
          evidenceRef: candidate.evidenceRef,
        })
      : null;

    insertMonitorAnomaly({
      id: candidate.id,
      detected_at: new Date().toISOString(),
      rule_id: candidate.ruleId,
      severity: candidate.severity,
      process_name: candidate.processName,
      remote_address: candidate.remoteAddress,
      description: candidate.description,
      evidence_ref: JSON.stringify(candidate.evidenceRef ?? {}),
      status: 'OPEN',
      security_signal: securitySignal,
    });
  }

  return candidates;
}

// Test-only reset — the in-memory "seen" sets are process-lifetime
// state (matches the baseline being a query, not a reset-per-cycle
// blob); tests need to clear them between cases.
export function _resetAnomalyState() {
  seenListeningPorts.clear();
  seenProcessesWithNetwork.clear();
}
