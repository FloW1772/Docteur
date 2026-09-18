/**
 * Mission lifecycle + orchestration for the Cyber Audit Agent (SENTINEL
 * V1, CA-7). This is the ONLY module allowed to wire the crawler (CA-6),
 * the detectors (CA-4), and evidence/finding persistence (CA-5) together
 * end to end for a mission. No route handler and no future UI may call
 * cyber-crawler.js, cyber-detect-*.js, or cyber-gateway.js directly — they
 * call only the functions exported here.
 *
 * State machine (CA-7's own — distinct from cyber-policy.js's earlier
 * DRAFT/SCOPED mission model, which nothing outside cyber-policy.js
 * consumed and is left untouched):
 *
 *   CREATED -> READY -> RUNNING -> COMPLETED
 *                          |-> CANCELLED
 *                          |-> FAILED
 *                          |-> BLOCKED_BY_POLICY
 *
 * CREATED/READY/CANCELLED/FAILED/BLOCKED_BY_POLICY are all terminal or
 * pre-run; only RUNNING can move forward, and only into one of the three
 * end states. Nothing may ever leave a terminal state (mirrors
 * metagpt-node-policy.js's TERMINAL_STATES/isValidTransition shape).
 */

import crypto from 'node:crypto';
import { validateMissionInput, denied, CyberAuditPolicyError, LIMITS } from './cyber-policy.js';
import { crawl } from './cyber-crawler.js';
import { detectHeaders } from './cyber-detect-headers.js';
import { detectCookies } from './cyber-detect-cookies.js';
import { detectInfoDisclosure } from './cyber-detect-info-disclosure.js';
import { recordEvidence, recordFinding } from './cyber-evidence.js';
import { generateMissionReport, generateFindingsJson } from './cyber-report.js';
import * as db from './sqlite.js';

export const CYBER_MISSION_STATES = Object.freeze({
  CREATED: 'CREATED',
  READY: 'READY',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY',
});

const TERMINAL_STATES = new Set([
  CYBER_MISSION_STATES.COMPLETED, CYBER_MISSION_STATES.CANCELLED,
  CYBER_MISSION_STATES.FAILED, CYBER_MISSION_STATES.BLOCKED_BY_POLICY,
]);

const FORWARD_EDGES = {
  [CYBER_MISSION_STATES.CREATED]: [CYBER_MISSION_STATES.READY],
  [CYBER_MISSION_STATES.READY]: [CYBER_MISSION_STATES.RUNNING],
  [CYBER_MISSION_STATES.RUNNING]: [CYBER_MISSION_STATES.COMPLETED],
};

// An in-flight mission may always escape to one of these three end
// states — a running scan can fail, be cancelled, or be blocked by
// policy at any point, but only FROM RUNNING (or READY, for a policy
// re-check that fails before the first request is even made).
const ESCAPE_EDGES = {
  [CYBER_MISSION_STATES.READY]: [CYBER_MISSION_STATES.CANCELLED, CYBER_MISSION_STATES.BLOCKED_BY_POLICY, CYBER_MISSION_STATES.FAILED],
  [CYBER_MISSION_STATES.RUNNING]: [CYBER_MISSION_STATES.CANCELLED, CYBER_MISSION_STATES.BLOCKED_BY_POLICY, CYBER_MISSION_STATES.FAILED],
};

export function isValidCyberMissionTransition(fromState, toState) {
  if (!Object.values(CYBER_MISSION_STATES).includes(fromState)) return false;
  if (!Object.values(CYBER_MISSION_STATES).includes(toState)) return false;
  if (TERMINAL_STATES.has(fromState)) return false;
  if ((FORWARD_EDGES[fromState] || []).includes(toState)) return true;
  if ((ESCAPE_EDGES[fromState] || []).includes(toState)) return true;
  return false;
}

// ---------------------------------------------------------------------
// In-memory runtime registry — mirrors metagpt-orchestrator.js's
// `runtime` Map: SQLite holds the durable record, this holds the live
// AbortController so /cancel can actually stop in-flight work.
// ---------------------------------------------------------------------
const runtime = new Map(); // missionId -> { controller, cancelled }

function nowIso() {
  return new Date().toISOString();
}

function logEvent(missionId, fromStatus, toStatus, detail = {}) {
  db.insertCyberAuditEvent({ id: crypto.randomUUID(), mission_id: missionId, from_status: fromStatus, to_status: toStatus, detail });
}

function transition(missionId, fromStatus, toStatus, extraUpdates = {}) {
  if (!isValidCyberMissionTransition(fromStatus, toStatus)) {
    throw denied(`invalid_transition:${fromStatus}->${toStatus}`);
  }
  db.updateCyberAuditMission(missionId, { status: toStatus, ...extraUpdates });
  logEvent(missionId, fromStatus, toStatus, extraUpdates.detail || {});
  return toStatus;
}

function safeErrorMessage(err) {
  // Never expose a stack trace, filesystem path, or raw error object to
  // the API/UI — only a short, structural, user-safe reason code.
  if (err instanceof CyberAuditPolicyError) return err.code;
  if (err && typeof err.code === 'string') return err.code;
  return 'unexpected_error';
}

function isPolicyError(err) {
  return err instanceof CyberAuditPolicyError;
}

// ---------------------------------------------------------------------
// 1 — CREATE
// ---------------------------------------------------------------------

/**
 * Creates a mission in CREATED state, then immediately advances it to
 * READY once its scope is durably persisted — a mission that exists in
 * the DB always has a frozen, valid scope; there is no window where a
 * caller could observe CREATED-without-scope and try to start it.
 */
export function createMission(body) {
  const validated = validateMissionInput(body); // throws CyberAuditPolicyError on any invalid field
  const id = crypto.randomUUID();

  db.insertCyberAuditMission({
    id, title: validated.title, client_name: validated.clientName,
    authorization_reference: validated.authorizationReference, mode: validated.mode,
  });
  logEvent(id, null, CYBER_MISSION_STATES.CREATED, {});

  db.insertCyberAuditScope({ mission_id: id, scope: validated.scope });
  transition(id, CYBER_MISSION_STATES.CREATED, CYBER_MISSION_STATES.READY);

  return toApiMission(db.getCyberAuditMissionById(id));
}

// ---------------------------------------------------------------------
// 2 — READ
// ---------------------------------------------------------------------

function computeCounts(missionId) {
  const requests = db.getCyberAuditRequestsForMission(missionId);
  const findings = db.getCyberAuditFindingsForMission(missionId);
  const pages = new Set(requests.map(r => r.url)).size;
  return { requests: requests.length, pages, findings: findings.length };
}

/**
 * Shapes a DB mission row into the minimal, clean API output the mission
 * requires — never an internal DB path, stack, raw cookie, token, or full
 * response body. The scope summary is host/port/protocol/limits only
 * (never a raw evidence body).
 */
function toApiMission(row) {
  if (!row) return null;
  const scopeRow = db.getCyberAuditScope(row.id);
  const counts = computeCounts(row.id);
  return {
    id: row.id,
    title: row.title,
    clientName: row.client_name,
    status: row.status,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.metadata?.cancelled_at ?? null,
    lastError: row.error_message ?? null,
    counts,
    scope: scopeRow
      ? {
        allowedHosts: scopeRow.scope.allowedHosts,
        allowedPorts: scopeRow.scope.allowedPorts,
        allowedProtocols: scopeRow.scope.allowedProtocols,
        maxDepth: scopeRow.scope.maxDepth,
        maxRequests: scopeRow.scope.maxRequests,
      }
      : null,
  };
}

export function getMission(id) {
  if (typeof id !== 'string' || !id) return null;
  return toApiMission(db.getCyberAuditMissionById(id));
}

export function listMissions() {
  return db.getAllCyberAuditMissions().map(toApiMission);
}

export function getMissionFindings(id) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) return null;
  return db.getCyberAuditFindingsForMission(id).map(f => ({
    id: f.id, title: f.title, category: f.category, severity: f.severity,
    confidence: f.confidence, status: f.status, asset: f.asset,
    description: f.description, impact: f.impact, recommendation: f.recommendation,
    references: f.references, evidenceIds: f.evidence_ids,
    firstSeen: f.first_seen, lastSeen: f.last_seen,
  }));
}

function toApiEvidence(row) {
  return {
    id: row.id, url: row.url, method: row.method, timestamp: row.timestamp,
    responseStatus: row.response_status, relevantHeaders: row.relevant_headers,
    excerpt: row.excerpt, sha256: row.sha256,
  };
}

export function getMissionEvidence(id, evidenceId) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) return null;
  const row = db.getCyberAuditEvidenceById(evidenceId);
  if (!row || row.mission_id !== id) return null;
  return toApiEvidence(row);
}

/**
 * All evidence for a mission (CA-9's report generator needs every piece
 * of evidence, not one at a time by id) — same minimal, already-redacted
 * shape as getMissionEvidence, never a raw DB row.
 */
export function getAllMissionEvidence(id) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) return null;
  return db.getCyberAuditEvidenceForMission(id).map(toApiEvidence);
}

export function getMissionEvents(id) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) return null;
  return db.getCyberAuditEventsForMission(id).map(e => ({
    fromStatus: e.from_status, toStatus: e.to_status, detail: e.detail, createdAt: e.created_at,
  }));
}

/**
 * CA-9: assembles a mission's already-persisted, already-API-shaped data
 * (never raw DB rows) and hands it to cyber-report.js's pure generator.
 * `format` is 'html' (default) or 'json' (findings only, for export) —
 * no other format exists; there is no PDF path (see mission: "PDF =
 * NOT IMPLEMENTED", no new heavy dependency added for it).
 */
export function getMissionReport(id, format = 'html') {
  const mission = getMission(id);
  if (!mission) return null;
  const findings = getMissionFindings(id) || [];
  if (format === 'json') {
    return { format: 'json', content: generateFindingsJson({ mission, findings }) };
  }
  const evidence = getAllMissionEvidence(id) || [];
  const events = getMissionEvents(id) || [];
  return { format: 'html', content: generateMissionReport({ mission, findings, evidence, events }) };
}

// ---------------------------------------------------------------------
// 3 — START
// ---------------------------------------------------------------------

/**
 * Starts a mission. Uses ONLY the scope already persisted at creation
 * time — the request body is never consulted for a URL/scope override,
 * so a caller cannot smuggle an arbitrary target in through /start.
 *
 * `allowPrivateFixture` exists ONLY for this test suite's local HTTP
 * fixture (127.0.0.1) — see cyber-policy.js's resolveInScope, which this
 * flag is threaded down to unchanged. The real HTTP route
 * (routes/cyber-audit.js) never passes it, so a real mission can never
 * bypass the private-address check.
 */
export function startMission(id, { allowPrivateFixture = false } = {}) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) throw denied('mission_not_found');
  if (mission.status !== CYBER_MISSION_STATES.READY) throw denied(`invalid_state_for_start:${mission.status}`);

  const scopeRow = db.getCyberAuditScope(id);
  if (!scopeRow) throw denied('mission_scope_missing');
  if (mission.authorization_confirmed !== true) throw denied('authorization_not_confirmed');

  // Re-validate the persisted scope against the current policy rules
  // (LIMITS may differ from when this mission was created, e.g. after a
  // server upgrade) — a scope that was valid then but violates today's
  // caps must block the mission rather than silently run with looser
  // limits than the server currently allows.
  let revalidatedScope;
  try {
    revalidatedScope = validateScopeShape(scopeRow.scope);
  } catch (err) {
    transition(id, mission.status, CYBER_MISSION_STATES.BLOCKED_BY_POLICY, { error_message: safeErrorMessage(err), detail: { reason: 'scope_revalidation_failed' } });
    return toApiMission(db.getCyberAuditMissionById(id));
  }

  const controller = new AbortController();
  runtime.set(id, { controller, cancelled: false });

  transition(id, mission.status, CYBER_MISSION_STATES.RUNNING, { started_at: nowIso() });

  // Fire-and-forget: the HTTP response to POST /start returns immediately
  // with the RUNNING state; the scan itself runs in the background and
  // updates mission state/events/findings as it progresses. Callers poll
  // GET /missions/:id or GET /missions/:id/events for progress.
  runMissionScan(id, revalidatedScope, controller.signal, { allowPrivateFixture }).catch(() => {
    // runMissionScan never throws (it catches internally and transitions
    // to FAILED) — this catch is defense in depth only, never reached in
    // normal operation.
  });

  return toApiMission(db.getCyberAuditMissionById(id));
}

function validateScopeShape(scope) {
  // Re-run the same structural checks validateScope() already applied at
  // creation time, via the frozen object shape rather than re-parsing
  // user input — this exists to catch a LIMITS tightening between mission
  // creation and start, not to re-trust untrusted input.
  if (!Array.isArray(scope.allowedHosts) || scope.allowedHosts.length === 0 || scope.allowedHosts.length > LIMITS.maxScopeHosts) {
    throw denied('scope_hosts_invalid');
  }
  if (!Array.isArray(scope.allowedPorts) || scope.allowedPorts.length === 0) throw denied('scope_ports_invalid');
  if (!Array.isArray(scope.allowedProtocols) || scope.allowedProtocols.length === 0) throw denied('scope_protocols_invalid');
  if (!Number.isInteger(scope.maxDepth) || scope.maxDepth < 0 || scope.maxDepth > LIMITS.maxDepth) throw denied('scope_depth_invalid');
  if (!Number.isInteger(scope.maxRequests) || scope.maxRequests < 1 || scope.maxRequests > LIMITS.maxRequests) throw denied('scope_max_requests_invalid');
  return scope;
}

// ---------------------------------------------------------------------
// 4 — CANCEL
// ---------------------------------------------------------------------

/**
 * Idempotent cancel. Calling this twice, or calling it after the scan has
 * already reached a terminal state, is always safe and never throws for
 * "already finished" — only mission-not-found is an error.
 */
export function cancelMission(id) {
  const mission = db.getCyberAuditMissionById(id);
  if (!mission) throw denied('mission_not_found');

  if (TERMINAL_STATES.has(mission.status)) {
    return { ...toApiMission(mission), alreadyFinished: true };
  }

  const entry = runtime.get(id);
  if (entry) entry.cancelled = true;
  entry?.controller.abort();

  // CREATED/READY (never started) can be cancelled directly with no
  // runtime entry to abort. RUNNING is cancelled via the controller
  // above; runMissionScan's own finally-block sees entry.cancelled and
  // will not overwrite CANCELLED with COMPLETED even if the crawl's
  // internal loop returns normally a few ms later (the exact race the
  // mission calls out explicitly).
  transition(id, mission.status, CYBER_MISSION_STATES.CANCELLED, { completed_at: nowIso(), detail: { cancelled: true } });
  return toApiMission(db.getCyberAuditMissionById(id));
}

// ---------------------------------------------------------------------
// 5 — ORCHESTRATED SCAN (crawler + detectors + evidence, wired together)
// ---------------------------------------------------------------------

function isHttpsUrl(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

/**
 * Runs one detector set against one crawled page's already-fetched data,
 * records evidence once, and records every finding produced. Detectors
 * remain pure — this is the only place their output is persisted.
 */
function processPage(missionId, requestId, page) {
  const asset = page.url;
  const isHttps = isHttpsUrl(page.url);
  const setCookie = page.headers?.['set-cookie'];

  const detectorFindings = [
    ...detectHeaders({ headers: page.headers || {}, isHttps, asset }),
    ...detectCookies({ setCookieHeader: setCookie, isHttps, asset }),
    ...detectInfoDisclosure({ headers: page.headers || {}, bodyExcerpt: (page.html || '').slice(0, 2000), asset }),
  ];

  const { id: evidenceId } = recordEvidence({
    missionId, requestId, url: page.url, method: 'GET',
    responseStatus: page.status, headers: page.headers || {},
    bodyExcerpt: (page.html || '').slice(0, 2000),
  });

  let findingsCreated = 0;
  for (const f of detectorFindings) {
    const withEvidence = { ...f, evidenceIds: [evidenceId] };
    const outcome = recordFinding({ missionId, finding: withEvidence });
    if (outcome.outcome === 'created') {
      findingsCreated += 1;
      logEvent(missionId, null, CYBER_MISSION_STATES.RUNNING, {
        type: 'FINDING_CREATED', findingId: f.id, severity: f.severity, category: f.category,
      });
    }
  }
  return findingsCreated;
}

/**
 * The actual scan: crawl (CA-6) -> per-page detectors (CA-4) -> evidence/
 * findings persistence (CA-5) -> mission counters/state (CA-7). Runs
 * entirely without any LLM call. Guarantees cleanup of the runtime
 * registry entry in every exit path (success, error, cancel, timeout).
 */
async function runMissionScan(missionId, scope, signal, { allowPrivateFixture = false } = {}) {
  const missionTimeout = setTimeout(() => {
    const entry = runtime.get(missionId);
    if (entry) entry.controller.abort();
  }, LIMITS.missionTimeoutMs);

  try {
    logEvent(missionId, null, CYBER_MISSION_STATES.RUNNING, { type: 'MISSION_STARTED' });

    // The start path is derived ONLY from the mission's already-persisted
    // scope, never from a request body (see startMission's own contract)
    // — when allowedPaths restricts the mission to a subpath, "/" itself
    // would be denied by the very first authorizeCyberRequest call and
    // the crawl would discover nothing, so the first allowed-path prefix
    // is used as the entry point instead of always assuming "/".
    const startPath = scope.allowedPaths && scope.allowedPaths.length > 0 ? scope.allowedPaths[0] : '/';
    const startUrls = scope.allowedHosts.slice(0, 1).map(host => {
      const protocol = scope.allowedProtocols.includes('https:') ? 'https:' : 'http:';
      const port = scope.allowedPorts[0];
      const defaultPort = protocol === 'https:' ? 443 : 80;
      const portSuffix = port === defaultPort ? '' : `:${port}`;
      return `${protocol}//${host}${portSuffix}${startPath}`;
    });

    let pagesScanned = 0;
    let findingsTotal = 0;

    const result = await crawl({
      startUrls, scope, signal, allowPrivateFixture,
      onPage: (page) => {
        pagesScanned += 1;
        const requestId = crypto.randomUUID();
        db.insertCyberAuditRequest({ id: requestId, mission_id: missionId, url: page.url, method: 'GET', status: page.status });
        try {
          findingsTotal += processPage(missionId, requestId, page);
        } catch {
          // A single page's detector/evidence failure must never abort
          // the whole scan — it's recorded as a request with no evidence
          // rather than crashing the mission.
        }
        if (pagesScanned % 10 === 0) {
          logEvent(missionId, null, CYBER_MISSION_STATES.RUNNING, { type: 'PAGE_SCANNED', count: pagesScanned });
        }
      },
    });

    const entry = runtime.get(missionId);
    if (entry?.cancelled) {
      // The crawl loop returned (e.g. it noticed the abort and unwound)
      // AFTER cancelMission() already committed CANCELLED — never
      // overwrite that with COMPLETED. This is exactly the race the
      // mission requires a test for.
      return;
    }

    const current = db.getCyberAuditMissionById(missionId);
    if (TERMINAL_STATES.has(current.status)) return; // already resolved by a concurrent cancel/fail

    transition(missionId, CYBER_MISSION_STATES.RUNNING, CYBER_MISSION_STATES.COMPLETED, {
      completed_at: nowIso(),
      detail: { pagesScanned, requestsMade: result.requestsMade, findingsTotal, stoppedReason: result.stoppedReason },
    });
    logEvent(missionId, null, CYBER_MISSION_STATES.COMPLETED, { type: 'MISSION_COMPLETED', pagesScanned, findingsTotal });
  } catch (err) {
    const entry = runtime.get(missionId);
    if (entry?.cancelled) return; // cancellation already recorded — do not also record FAILED

    const current = db.getCyberAuditMissionById(missionId);
    if (!current || TERMINAL_STATES.has(current.status)) return;

    const toStatus = isPolicyError(err) ? CYBER_MISSION_STATES.BLOCKED_BY_POLICY : CYBER_MISSION_STATES.FAILED;
    transition(missionId, CYBER_MISSION_STATES.RUNNING, toStatus, {
      completed_at: nowIso(), error_message: safeErrorMessage(err),
      detail: { type: toStatus === CYBER_MISSION_STATES.BLOCKED_BY_POLICY ? 'POLICY_BLOCKED' : 'MISSION_FAILED' },
    });
  } finally {
    clearTimeout(missionTimeout);
    runtime.delete(missionId);
  }
}

// Exposed for tests only — not part of the public API surface used by
// routes. Lets orchestrator tests inject a fake crawl/detector failure,
// or directly corrupt a persisted scope's shape to prove the
// BLOCKED_BY_POLICY path, without needing a real network fixture for
// every scenario.
export const __testing = { runMissionScan, processPage, runtime, validateScopeShape };
