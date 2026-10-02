// Notebook NB-5 — DOCTEUR MEMORY service: APPROVED memory only.
//
//   NB-4 candidate ─► human review ─► (edit) ─► APPROVE ─► MemoryItem ─► contextual retrieval ─► LLM context
//
// • Nothing becomes memory automatically: every item is created by an explicit human action
//   (promote a candidate, merge candidates, or write a manual note). There is no bulk / auto path.
// • Memory ≠ raw history: an item is a short statement (≤ 400 chars) + evidence LINKS (never copies).
// • Scopes: GLOBAL (rare, transversal) · PROJECT (main scope) · NOTEBOOK. A query never sees another
//   project's or notebook's memory; an unresolved project injects no project memory.
// • Supersession is only ever CONFIRMED by a human; conflicts are surfaced, never silently resolved.
// • Memory is context, not authority: it can't change instructions or trigger any tool (see -context.js).
// • STRICT LOCAL: no network, no cloud, no child_process; embeddings via the injected local embedder.

import crypto from 'node:crypto';
import { getDatabase, getNotebook } from './sqlite.js';
import * as ai from './notebook-ai-store.js';
import { scanSecrets, redactDocumentSecrets, detectInjection } from './notebook-security.js';
import { detectConflicts } from './notebook-conflicts.js';
import { queryTerms, TRUST_LEVELS } from './notebook-docs-store.js';
import { resolveRetrievalConfig, gateFtsHits, gateVectorHits, fuseRanked, shingleJaccard, normalizedTextKey, estimateTokens } from './notebook-retrieval.js';
import { resolveEmbedFormat } from './notebook-documents.js';
import { upsertMemoryVectors, searchMemoryVectors, deleteMemoryVectors } from './lancedb.js';
import { parseRetentionDuration } from './notebook-retention.js';
import { ensureMemorySchema } from './notebook-memory-schema.js';
import { buildMemoryContextPack, buildMemoryMessages, MEMORY_SYSTEM_PROMPT } from './notebook-memory-context.js';

export const MEMORY_TYPES = Object.freeze(['PROJECT_FACT', 'DECISION', 'REQUIREMENT', 'PREFERENCE', 'TECHNICAL_DISCOVERY', 'RESOLVED_QUESTION', 'OPEN_QUESTION', 'WORKFLOW', 'CONSTRAINT', 'PERSONAL_NOTE']);
export const MEMORY_STATUSES = Object.freeze(['APPROVED', 'SUPERSEDED', 'REVOKED', 'ARCHIVED']);
export const SCOPE_KINDS = Object.freeze(['GLOBAL', 'PROJECT', 'NOTEBOOK']);
export const SENSITIVITIES = Object.freeze(['NORMAL', 'SENSITIVE', 'HIGHLY_SENSITIVE']);
export const MEMORY_RETENTIONS = Object.freeze(['KEEP', 'MANUAL', 'DELETE_AFTER', 'SESSION_ONLY']);
export const MAX_STATEMENT_CHARS = 400;
export const MIN_STATEMENT_CHARS = 8;
// NB-4 candidate types that map 1:1; SNIPPET / TODO must be given an explicit memory type by the human.
const CANDIDATE_TYPE_OK = new Set(['PROJECT_FACT', 'DECISION', 'REQUIREMENT', 'PREFERENCE', 'TECHNICAL_DISCOVERY', 'RESOLVED_QUESTION', 'OPEN_QUESTION', 'PERSONAL_NOTE']);
// GLOBAL is reserved for transversal information; any other type needs an explicit confirmation.
const GLOBAL_OK_TYPES = new Set(['PREFERENCE', 'CONSTRAINT', 'WORKFLOW', 'REQUIREMENT', 'PERSONAL_NOTE']);
const SUPERSEDABLE = new Set(['DECISION', 'REQUIREMENT', 'PREFERENCE', 'WORKFLOW', 'CONSTRAINT', 'PROJECT_FACT']);

export const MEMORY_RETRIEVAL_DEFAULTS = Object.freeze({
  // Calibrated with REAL nomic-embed-text embeddings on the NB-5 corpus (nb5-calibrate.mjs, reports/nb5-calibration-results.json):
  // cosine 0.7 admits vector-only false positives on short statements (0.70–0.72 for unrelated queries) ⇒ 0.75; top-k 3 keeps hit@k and cuts noise.
  topK: 3, poolMultiplier: 4, rrfK: 60, ftsWeight: 1, vectorWeight: 0.5, vectorThreshold: 0.75, minLexicalCoverage: 0.34,
  scopeBoost: Object.freeze({ NOTEBOOK: 1.25, PROJECT: 1.12, GLOBAL: 1 }), // ordering only — a boost is never authority
  nearDuplicateJaccard: 0.85, maxContextTokens: 800,
});

// Deterministic, local query normalisation: question words / auxiliaries carry no topic. Measured on the NB-5
// corpus (nb5-calibrate.mjs): they dropped lexical coverage below the gate ("Comment sont gérés les paiements ?")
// and admitted weak single-word matches ("utilise"). Applied to the query only, never to stored statements.
const MEMORY_QUERY_STOP = new Set(('comment quand pourquoi combien quel quelle quels quelles peut peux peuvent puis pouvons faut doit doivent fait faire font sont etait etais ' +
  'utilise utilisent utiliser utilisons utilisions utilisait utilises utilisez veux voulais voulait sait dit donne donnes parle parles explique expliquer ecris ecrire traduis ' +
  'avant apres encore deja toujours jamais vers chez').split(/\s+/));
export const memoryQueryTerms = (q) => queryTerms(q).filter(t => !MEMORY_QUERY_STOP.has(t));

export class MemoryError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'MemoryError'; this.code = code; Object.assign(this, extra); }
}

const PII = [
  ['EMAIL', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['PHONE', /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?\d(?:[ .-]?\d){8,13}(?![\w])/],
  ['IBAN', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/],
  ['ADDRESS', /\b\d{1,4}\s+(?:rue|avenue|boulevard|chemin|street|road|st\.)\b/i],
  ['NATIONAL_ID', /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\b/],
];
export function detectPii(text) { return PII.filter(([, re]) => re.test(text)).map(([k]) => k); }

// Text copied from another store (candidate statement, evidence quote, document chunk) is re-scanned: a secret is masked,
// and a private key blocks the whole snippet — memory never becomes a second place where a secret lives.
export function safeCopy(text) {
  const t = String(text ?? ''); const scan = scanSecrets(t);
  if (!scan.hasSecrets) return t;
  return scan.mustBlock ? '[contenu masqué : secret]' : redactDocumentSecrets(t);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIsoDefault = () => new Date().toISOString();
const newId = (p) => `${p}-${crypto.randomUUID()}`;

export function normalizeStatement(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}
function keyOf(statement) {
  const terms = [...new Set(queryTerms(statement))].sort().slice(0, 14);
  return terms.length ? sha(terms.join(' ')).slice(0, 24) : sha(normalizedTextKey(statement)).slice(0, 24);
}

function rowToItem(r) {
  if (!r) return null;
  let provenance = {}; try { provenance = JSON.parse(r.provenance); } catch { /* keep {} */ }
  let flags = []; try { flags = JSON.parse(r.injection_flags); } catch { /* keep [] */ }
  return {
    memoryId: r.memory_id, statement: r.statement, type: r.type, status: r.status, scopeKind: r.scope_kind, projectId: r.project_id || null, notebookId: r.notebook_id || null,
    scope: { kind: r.scope_kind, projectId: r.project_id || null, notebookId: r.notebook_id || null },
    confidence: r.confidence, trustLevel: r.trust_level, sensitivity: r.sensitivity, createdAt: r.created_at, updatedAt: r.updated_at, approvedAt: r.approved_at,
    effectiveFrom: r.effective_from, effectiveUntil: r.effective_until, supersededBy: r.superseded_by, sourceKind: r.source_kind, sourceCandidateId: r.source_candidate_id,
    sourceNotebookId: r.source_notebook_id, originalStatement: r.original_statement, editedBeforeApproval: r.edited_before_approval === 1, approvalSource: r.approval_source,
    provenance, injectionFlags: flags, version: r.version, retention: r.retention, expiresAt: r.expires_at, sessionId: r.session_id, needsReview: r.needs_review === 1,
    provenanceStatus: r.needs_review === 1 ? 'MISSING' : (provenance.origin === 'USER_AUTHORED_MANUAL' ? 'MANUAL' : 'OK'),
  };
}

export function createMemoryService(deps) {
  const provider = deps.embeddingProvider ?? 'ollama';
  const model = deps.embeddingModel;
  const embedFormat = resolveEmbedFormat(model, deps.embedFormat);
  const baseCfg = resolveRetrievalConfig(MEMORY_RETRIEVAL_DEFAULTS, deps.retrieval);
  const clock = deps.now ?? (() => Date.now());
  const nowIso = () => new Date(clock()).toISOString();
  const sessionId = deps.sessionId ?? crypto.randomUUID();
  const log = (level, obj, msg) => { try { deps.logger?.[level]?.(obj, msg); } catch { /* ignore */ } };
  const vectorStore = deps.vectorStore ?? {
    upsert: (rows) => upsertMemoryVectors(deps.lancedbPath, rows),
    search: (v, o) => searchMemoryVectors(deps.lancedbPath, v, o),
    delete: (ids) => deleteMemoryVectors(deps.lancedbPath, ids),
  };
  const db = () => getDatabase();
  const embedDoc = (t) => deps.embedText(`${embedFormat.docPrefix}${t}`);
  const embedQuery = (t) => deps.embedText(`${embedFormat.queryPrefix}${t}`);

  // ── schema is created by notebook-docs-store.ensureNotebookDocsSchema (called by the document service) ──
  const vis = (alias = 'm') => ({ sql: `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?) AND (${alias}.retention != 'SESSION_ONLY' OR ${alias}.session_id = ?)`, params: [nowIso(), sessionId] });

  // ── projects ───────────────────────────────────────────────────────────────
  function createProject({ projectId, name }) {
    const id = String(projectId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new MemoryError('INVALID_SCOPE', 'projectId invalide (lettres, chiffres, _ et - ; 64 max)');
    const nm = normalizeStatement(name || id).slice(0, 80);
    if (db().prepare('SELECT 1 FROM dmem_projects WHERE project_id = ?').get(id)) throw new MemoryError('INVALID_SCOPE', 'Projet déjà existant');
    db().prepare('INSERT INTO dmem_projects (project_id, name, created_at) VALUES (?,?,?)').run(id, nm, nowIso());
    return { projectId: id, name: nm };
  }
  const listProjects = () => db().prepare('SELECT project_id, name, created_at FROM dmem_projects ORDER BY project_id').all().map(r => ({ projectId: r.project_id, name: r.name, createdAt: r.created_at }));
  const getProject = (id) => { const r = db().prepare('SELECT * FROM dmem_projects WHERE project_id = ?').get(id); return r ? { projectId: r.project_id, name: r.name } : null; };
  function setNotebookProject(notebookId, projectId) {
    if (!getNotebook(notebookId)) throw new MemoryError('INVALID_SCOPE', 'Notebook introuvable');
    if (projectId == null) { db().prepare('DELETE FROM dmem_notebook_projects WHERE notebook_id = ?').run(notebookId); return { notebookId, projectId: null }; }
    if (!getProject(projectId)) throw new MemoryError('INVALID_SCOPE', 'Projet inconnu');
    db().prepare('INSERT INTO dmem_notebook_projects (notebook_id, project_id, updated_at) VALUES (?,?,?) ON CONFLICT(notebook_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at').run(notebookId, projectId, nowIso());
    return { notebookId, projectId };
  }
  const projectOfNotebook = (nb) => db().prepare('SELECT project_id FROM dmem_notebook_projects WHERE notebook_id = ?').get(nb)?.project_id ?? null;

  // The active project is NEVER guessed: explicit context, else the notebook's explicit mapping, else unresolved.
  function resolveContext({ activeProject = null, activeNotebook = null } = {}) {
    if (activeProject != null && !getProject(activeProject)) throw new MemoryError('INVALID_SCOPE', `Projet inconnu : ${activeProject}`);
    if (activeNotebook != null && !getNotebook(activeNotebook)) throw new MemoryError('INVALID_SCOPE', 'Notebook introuvable');
    if (activeProject) return { projectId: activeProject, notebookId: activeNotebook, projectSource: 'explicit' };
    const mapped = activeNotebook ? projectOfNotebook(activeNotebook) : null;
    return { projectId: mapped, notebookId: activeNotebook, projectSource: mapped ? 'notebook' : null };
  }

  // ── validation shared by create / promote / edit ──────────────────────────
  function validateScope(scope, type, { confirmGlobal = false } = {}) {
    const kind = scope?.kind;
    if (!SCOPE_KINDS.includes(kind)) throw new MemoryError('INVALID_SCOPE', `scope invalide : ${kind} (${SCOPE_KINDS.join(', ')})`);
    if (kind === 'GLOBAL') {
      if (scope.projectId || scope.notebookId) throw new MemoryError('INVALID_SCOPE', 'Un souvenir GLOBAL n\'a ni projet ni notebook');
      if (!GLOBAL_OK_TYPES.has(type) && !confirmGlobal) throw new MemoryError('APPROVAL_REQUIRED', 'GLOBAL est réservé aux informations transversales : confirme explicitement (confirmGlobal) ou choisis PROJECT / NOTEBOOK', { field: 'confirmGlobal' });
      return { kind, projectId: null, notebookId: null };
    }
    if (kind === 'PROJECT') {
      if (!scope.projectId || !getProject(scope.projectId)) throw new MemoryError('INVALID_SCOPE', 'Projet inconnu ou manquant');
      return { kind, projectId: scope.projectId, notebookId: null };
    }
    if (!scope.notebookId || !getNotebook(scope.notebookId)) throw new MemoryError('INVALID_SCOPE', 'Notebook inconnu ou manquant');
    return { kind, projectId: null, notebookId: scope.notebookId };
  }

  function prepareStatement(raw, type, o = {}) {
    if (!MEMORY_TYPES.includes(type)) throw new MemoryError('UNSUPPORTED_TYPE', `Type de mémoire non supporté : ${type} (${MEMORY_TYPES.join(', ')})`);
    let statement = normalizeStatement(raw);
    if (statement.length < MIN_STATEMENT_CHARS) throw new MemoryError('MEMORY_TOO_SHORT', `Souvenir trop court (min ${MIN_STATEMENT_CHARS} caractères)`);
    if (statement.length > MAX_STATEMENT_CHARS) throw new MemoryError('MEMORY_TOO_LONG', `Un souvenir est concis : ${MAX_STATEMENT_CHARS} caractères maximum (ce n'est pas une conversation)`);
    // secrets are re-scanned at every approve / edit, whatever NB-4 already did
    const scan = scanSecrets(statement); let redacted = false;
    if (scan.hasSecrets) {
      if (scan.mustBlock || o.secretPolicy !== 'redact') throw new MemoryError('SECRET_DETECTED', 'Un secret a été détecté dans ce souvenir : approbation refusée (kinds : ' + scan.findings.map(f => f.kind).join(', ') + ')', { findings: scan.findings.map(f => ({ kind: f.kind, count: f.count })) });
      statement = normalizeStatement(redactDocumentSecrets(statement)); redacted = true;
    }
    // personal / sensitive content: explicit confirmation, and never NORMAL by accident
    const pii = detectPii(statement); const sens = o.sensitivity ?? 'NORMAL';
    if (!SENSITIVITIES.includes(sens)) throw new MemoryError('INVALID_OPTION', `sensitivity invalide : ${sens}`);
    if ((type === 'PERSONAL_NOTE' || pii.length) && sens === 'NORMAL' && !o.confirmSensitive) {
      throw new MemoryError('APPROVAL_REQUIRED', 'Contenu personnel/sensible détecté : choisis SENSITIVE ou HIGHLY_SENSITIVE, ou confirme explicitement (confirmSensitive)', { field: 'sensitivity', suggested: 'SENSITIVE', pii });
    }
    return { statement, redacted, pii, injection: detectInjection(statement).kinds };
  }

  function validateRetention(o, from) {
    const retention = o.retention ?? 'KEEP';
    if (!MEMORY_RETENTIONS.includes(retention)) throw new MemoryError('INVALID_OPTION', `Rétention inconnue : ${retention}`);
    let expiresAt = null;
    if (retention === 'DELETE_AFTER') { const ms = parseRetentionDuration(o.retentionDuration); if (ms == null) throw new MemoryError('INVALID_OPTION', 'DELETE_AFTER exige une durée valide (1h, 24h, 7d…)'); expiresAt = new Date(from + ms).toISOString(); }
    else if (o.retentionDuration) throw new MemoryError('INVALID_OPTION', 'Une durée n\'est acceptée qu\'avec DELETE_AFTER');
    return { retention, expiresAt, sessionId: retention === 'SESSION_ONLY' ? sessionId : null };
  }

  function findDuplicate(statement, scope) {
    const key = keyOf(statement);
    const rows = db().prepare(`SELECT * FROM dmem_items WHERE status = 'APPROVED' AND scope_kind = ? AND COALESCE(project_id,'') = ? AND COALESCE(notebook_id,'') = ?`).all(scope.kind, scope.projectId ?? '', scope.notebookId ?? '');
    for (const r of rows) { if (r.norm_key === key || shingleJaccard(r.statement, statement) >= baseCfg.nearDuplicateJaccard) return rowToItem(r); }
    return null;
  }

  // ── writes ────────────────────────────────────────────────────────────────
  const audit = (id, action, actor = 'user', oldS = null, newS = null) => db().prepare('INSERT INTO dmem_audit (memory_id, action, actor, old_status, new_status, at) VALUES (?,?,?,?,?,?)').run(id, action, actor, oldS, newS, nowIso());
  const revision = (id, version, action, f = {}) => db().prepare('INSERT INTO dmem_revisions (revision_id, memory_id, version, action, old_statement, new_statement, old_status, new_status, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(newId('nrev'), id, version, action, f.oldStatement ?? null, f.newStatement ?? null, f.oldStatus ?? null, f.newStatus ?? null, f.reason ?? null, nowIso());
  const projectName = (pid) => (pid ? (getProject(pid)?.name ?? pid) : '');
  const ftsInsert = (m) => db().prepare('INSERT INTO dmem_items_fts (statement, type, project, memory_id) VALUES (?,?,?,?)').run(m.statement, m.type.replace(/_/g, ' '), `${projectName(m.project_id)} ${m.scope_kind}`.trim(), m.memory_id);
  const ftsDelete = (id) => db().prepare('DELETE FROM dmem_items_fts WHERE memory_id = ?').run(id);

  function insertItem({ statement, type, scope, sensitivity, confidence, trustLevel, sourceKind, sourceCandidateId, sourceNotebookId, originalStatement, edited, approvalSource, provenance, injection, retention, effectiveFrom, evidence }) {
    const id = newId('nmem'); const t = nowIso();
    const row = {
      memory_id: id, statement, type, status: 'APPROVED', scope_kind: scope.kind, project_id: scope.projectId ?? '', notebook_id: scope.notebookId ?? '', confidence, trust_level: trustLevel,
      sensitivity, created_at: t, updated_at: t, approved_at: t, effective_from: effectiveFrom ?? t, effective_until: null, source_kind: sourceKind, source_candidate_id: sourceCandidateId ?? null,
      source_notebook_id: sourceNotebookId ?? null, original_statement: originalStatement ?? null, edited: edited ? 1 : 0, approval_source: approvalSource,
      provenance: JSON.stringify(provenance), injection_flags: JSON.stringify(injection), retention: retention.retention, expires_at: retention.expiresAt, session_id: retention.sessionId,
      norm_key: keyOf(statement), statement_hash: sha(statement),
    };
    db().transaction(() => {
      db().prepare(`INSERT INTO dmem_items (memory_id, statement, type, status, scope_kind, project_id, notebook_id, confidence, trust_level, sensitivity, created_at, updated_at, approved_at, effective_from,
          effective_until, source_kind, source_candidate_id, source_notebook_id, original_statement, edited_before_approval, approval_source, provenance, injection_flags, version, retention, expires_at, session_id, norm_key, statement_hash)
        VALUES (@memory_id,@statement,@type,@status,@scope_kind,@project_id,@notebook_id,@confidence,@trust_level,@sensitivity,@created_at,@updated_at,@approved_at,@effective_from,@effective_until,@source_kind,
          @source_candidate_id,@source_notebook_id,@original_statement,@edited,@approval_source,@provenance,@injection_flags,1,@retention,@expires_at,@session_id,@norm_key,@statement_hash)`).run(row);
      ftsInsert(row);
      const ev = db().prepare('INSERT OR IGNORE INTO dmem_evidence (memory_id, kind, ref, source_id, conversation_id, provider, role, trust_level, quote, ts, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const e of evidence ?? []) ev.run(id, e.kind, e.ref, e.sourceId ?? null, e.conversationId ?? null, e.provider ?? null, e.role ?? null, e.trustLevel ?? null, safeCopy(String(e.quote ?? '').slice(0, 300)), e.ts ?? null, 'OK', t);
      revision(id, 1, sourceKind === 'MANUAL' ? 'CREATE_MANUAL' : 'APPROVE', { newStatement: statement, newStatus: 'APPROVED' });
      audit(id, sourceKind === 'MANUAL' ? 'CREATE_MANUAL' : 'APPROVE', 'user', null, 'APPROVED');
    })();
    return id;
  }

  // ── embeddings (same compat rules as NB-3) ────────────────────────────────
  async function indexVector(memoryId) {
    const m = db().prepare('SELECT * FROM dmem_items WHERE memory_id = ?').get(memoryId);
    if (!m || m.status === 'REVOKED') return 'SKIPPED';
    let v;
    try { v = await embedDoc(`${m.type.replace(/_/g, ' ')}: ${m.statement}`); if (!Array.isArray(v) || !v.length || v.some(x => !Number.isFinite(x))) throw new Error('invalid embedding'); } catch { return 'VECTOR_UNAVAILABLE'; }
    try {
      await vectorStore.upsert([{ memory_id: memoryId, scope_kind: m.scope_kind, project_id: m.project_id, notebook_id: m.notebook_id, vector: v }]);
    } catch { return 'VECTOR_UNAVAILABLE'; }
    const cur = db().prepare('SELECT statement_hash, status FROM dmem_items WHERE memory_id = ?').get(memoryId);
    if (!cur || cur.status === 'REVOKED' || cur.statement_hash !== m.statement_hash) { await vectorStore.delete([memoryId]).catch(() => {}); return cur ? 'STALE' : 'DELETED'; } // deleted / edited meanwhile: never leave a stale or resurrected vector
    db().prepare('INSERT OR REPLACE INTO dmem_embeddings (memory_id, provider, model, dimension, embed_version, statement_hash, created_at) VALUES (?,?,?,?,?,?,?)').run(memoryId, provider, model, v.length, embedFormat.version, m.statement_hash, nowIso());
    return 'READY';
  }

  async function finalize(memoryId) {
    const vector = await indexVector(memoryId);
    const conflicts = detectConflictsFor(memoryId);
    const suggestions = suggestSupersessions(memoryId);
    return { vector, conflicts, suggestions };
  }

  // ── promote a NB-4 candidate (explicit human action) ──────────────────────
  async function promoteCandidate(o) {
    const { notebookId, candidateId } = o;
    const cand = ai.getCandidate(notebookId, candidateId);
    if (!cand) throw new MemoryError('MEMORY_NOT_FOUND', 'Candidat introuvable dans ce Notebook');
    if (cand.status === 'REJECTED' || cand.status === 'SUPERSEDED') throw new MemoryError('INVALID_STATUS', `Un candidat ${cand.status} ne peut pas devenir un souvenir`);
    const already = db().prepare(`SELECT memory_id FROM dmem_items WHERE source_candidate_id = ? AND status != 'REVOKED'`).get(candidateId);
    if (already) throw new MemoryError('INVALID_STATUS', 'Ce candidat est déjà un souvenir', { memoryId: already.memory_id });
    const type = o.type ?? cand.type;
    if (!o.type && !CANDIDATE_TYPE_OK.has(cand.type)) throw new MemoryError('UNSUPPORTED_TYPE', `Le type de candidat ${cand.type} n'est pas un type de mémoire : choisis explicitement un type`, { field: 'type' });
    const evidence = ai.listEvidence(candidateId);
    if (!evidence.length) throw new MemoryError('PROVENANCE_MISSING', 'Ce candidat n\'a plus aucune preuve : un souvenir sans provenance est interdit (crée une note manuelle si tu veux le garder)');
    const scope = validateScope(o.scope, type, o);
    const prepared = prepareStatement(o.statement ?? cand.statement, type, o);
    const edited = prepared.statement !== normalizeStatement(cand.statement);
    if (!o.allowDuplicate) { const dup = findDuplicate(prepared.statement, scope); if (dup) throw new MemoryError('DUPLICATE_MEMORY', 'Un souvenir identique ou quasi identique existe déjà dans ce scope', { duplicateOf: dup.memoryId }); }
    const convs = ai.getConversationsByIds([...new Set(evidence.map(e => e.conversationId))]);
    const ts = evidence.map(e => e.ts).filter(Boolean).sort();
    const provenance = {
      origin: 'NB4_CANDIDATE', candidateId, candidateType: cand.type, originalStatement: safeCopy(cand.statement), notebookId, evidenceCount: evidence.length,
      providers: [...new Set([...convs.values()].map(c => c.provider))], roles: [...new Set(evidence.map(e => e.role))], dates: { from: ts[0] ?? null, to: ts.at(-1) ?? null }, conversations: convs.size,
    };
    const ret = validateRetention(o, clock());
    const id = insertItem({
      statement: prepared.statement, type, scope, sensitivity: o.sensitivity ?? 'NORMAL', confidence: cand.confidence, trustLevel: cand.trustLevel, sourceKind: 'CANDIDATE', sourceCandidateId: candidateId, sourceNotebookId: notebookId,
      originalStatement: safeCopy(cand.statement), edited, approvalSource: o.approvalSource ?? 'USER_UI', provenance, injection: prepared.injection, retention: ret, effectiveFrom: o.effectiveFrom ?? cand.statedAt ?? undefined,
      evidence: evidence.map(e => ({ kind: 'AI_HISTORY_MESSAGE', ref: e.messageId, sourceId: e.importId, conversationId: e.conversationId, provider: convs.get(e.conversationId)?.provider ?? 'UNKNOWN', role: e.role, trustLevel: e.role === 'USER' ? 'USER_AUTHORED' : 'PAST_AI_OUTPUT', quote: safeCopy(e.quote), ts: e.ts })),
    });
    ai.updateCandidate(candidateId, { status: cand.status === 'CANDIDATE' ? 'APPROVED' : cand.status, promotion: 'MEMORY' });
    // NB-4 possible supersession links → suggestions (never applied here)
    for (const l of ai.listLinks(candidateId)) {
      if (l.kind !== 'POSSIBLE_SUPERSEDES') continue; // candidateId supersedes relatedId
      const thisIsNew = l.candidateId === candidateId; const other = thisIsNew ? l.relatedId : l.candidateId;
      const om = db().prepare(`SELECT memory_id FROM dmem_items WHERE source_candidate_id = ? AND status = 'APPROVED'`).get(other);
      if (om) addSuggestion(thisIsNew ? id : om.memory_id, thisIsNew ? om.memory_id : id, l.ambiguous, `depuis NB-4 : ${l.detail}`);
    }
    const fin = await finalize(id);
    log('info', { memoryId: id, status: 'APPROVED', scope: scope.kind, stage: 'PROMOTE' }, 'NOTEBOOK_MEMORY_APPROVED');
    return { memory: getMemory(id), ...fin, redacted: prepared.redacted, warnings: prepared.pii.length ? { pii: prepared.pii } : undefined };
  }

  // The user merges several near-identical candidates into ONE memory with several evidence (explicit, never automatic).
  async function promoteMerged(o) {
    const { notebookId, candidateIds } = o;
    if (!Array.isArray(candidateIds) || candidateIds.length < 2) throw new MemoryError('INVALID_OPTION', 'Fusion : au moins 2 candidats');
    const cands = candidateIds.map(id => ai.getCandidate(notebookId, id));
    if (cands.some(c => !c)) throw new MemoryError('MEMORY_NOT_FOUND', 'Candidat introuvable');
    if (cands.some(c => c.status === 'REJECTED' || c.status === 'SUPERSEDED')) throw new MemoryError('INVALID_STATUS', 'Un candidat rejeté/remplacé ne peut pas être fusionné');
    if (new Set(cands.map(c => c.type)).size > 1 && !o.type) throw new MemoryError('APPROVAL_REQUIRED', 'Types différents : choisis explicitement le type du souvenir fusionné', { field: 'type' });
    const primary = cands[0];
    const res = await promoteCandidate({ ...o, candidateId: primary.candidateId, statement: o.statement ?? primary.statement, allowDuplicate: o.allowDuplicate });
    const id = res.memory.memoryId;
    const convs = new Map();
    db().transaction(() => {
      for (const c of cands.slice(1)) {
        const ev = ai.listEvidence(c.candidateId); const cv = ai.getConversationsByIds([...new Set(ev.map(e => e.conversationId))]); for (const [k, v] of cv) convs.set(k, v);
        const ins = db().prepare('INSERT OR IGNORE INTO dmem_evidence (memory_id, kind, ref, source_id, conversation_id, provider, role, trust_level, quote, ts, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const e of ev) ins.run(id, 'AI_HISTORY_MESSAGE', e.messageId, e.importId, e.conversationId, cv.get(e.conversationId)?.provider ?? 'UNKNOWN', e.role, e.role === 'USER' ? 'USER_AUTHORED' : 'PAST_AI_OUTPUT', safeCopy(String(e.quote ?? '').slice(0, 300)), e.ts, 'OK', nowIso());
        ai.updateCandidate(c.candidateId, { status: c.status === 'CANDIDATE' ? 'APPROVED' : c.status, promotion: 'MEMORY' });
      }
      const p = getMemory(id).provenance; const n = db().prepare(`SELECT COUNT(*) n FROM dmem_evidence WHERE memory_id = ?`).get(id).n;
      db().prepare('UPDATE dmem_items SET provenance = ? WHERE memory_id = ?').run(JSON.stringify({ ...p, mergedCandidateIds: candidateIds, evidenceCount: n }), id);
    })();
    return { ...res, memory: getMemory(id), mergedCandidates: candidateIds.length };
  }

  // Groups of pending candidates that say essentially the same thing (proposal only — nothing is merged).
  function proposeMerges(notebookId, { minJaccard = 0.6, limit = 200 } = {}) {
    const list = ai.listCandidates(notebookId, { status: 'CANDIDATE', limit }).filter(c => CANDIDATE_TYPE_OK.has(c.type));
    const groups = []; const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(list[i].candidateId)) continue;
      const g = [list[i]];
      for (let j = i + 1; j < list.length; j++) if (!used.has(list[j].candidateId) && list[j].type === list[i].type && shingleJaccard(list[i].statement, list[j].statement) >= minJaccard) g.push(list[j]);
      if (g.length > 1) { g.forEach(c => used.add(c.candidateId)); groups.push({ type: list[i].type, candidateIds: g.map(c => c.candidateId), statements: g.map(c => c.statement), ambiguous: new Set(g.map(c => keyOf(c.statement))).size > 1 }); }
    }
    return groups;
  }

  async function createManual(o) {
    const type = o.type;
    const scope = validateScope(o.scope, type, o);
    const prepared = prepareStatement(o.statement, type, o);
    if (!o.allowDuplicate) { const dup = findDuplicate(prepared.statement, scope); if (dup) throw new MemoryError('DUPLICATE_MEMORY', 'Un souvenir identique ou quasi identique existe déjà dans ce scope', { duplicateOf: dup.memoryId }); }
    // optional evidence: only chunks that really exist in the named notebook
    const evidence = [];
    for (const e of o.evidence ?? []) {
      if (e.kind !== 'DOCUMENT_CHUNK') throw new MemoryError('INVALID_OPTION', 'Seule une preuve DOCUMENT_CHUNK peut être jointe à une note manuelle');
      const row = db().prepare('SELECT c.chunk_id, c.document_id, c.text, c.trust_level FROM nb_chunks c JOIN nb_documents d ON d.document_id = c.document_id WHERE c.chunk_id = ? AND c.notebook_id = ? AND c.is_current = 1').get(e.chunkId, e.notebookId);
      if (!row) throw new MemoryError('PROVENANCE_MISSING', 'Preuve introuvable');
      evidence.push({ kind: 'DOCUMENT_CHUNK', ref: row.chunk_id, sourceId: row.document_id, trustLevel: row.trust_level, quote: safeCopy(row.text.slice(0, 300)) });
    }
    const id = insertItem({
      statement: prepared.statement, type, scope, sensitivity: o.sensitivity ?? 'NORMAL', confidence: 1, trustLevel: 'USER_AUTHORED', sourceKind: 'MANUAL', originalStatement: null, edited: false,
      approvalSource: o.approvalSource ?? 'USER_UI', provenance: { origin: 'USER_AUTHORED_MANUAL', evidenceCount: evidence.length }, injection: prepared.injection, retention: validateRetention(o, clock()), effectiveFrom: o.effectiveFrom, evidence,
    });
    const fin = await finalize(id);
    log('info', { memoryId: id, status: 'APPROVED', scope: scope.kind, stage: 'MANUAL' }, 'NOTEBOOK_MEMORY_CREATED');
    return { memory: getMemory(id), ...fin, redacted: prepared.redacted, warnings: prepared.pii.length ? { pii: prepared.pii } : undefined };
  }

  function lockCheck(row, expectedVersion) { if (expectedVersion != null && Number(expectedVersion) !== row.version) throw new MemoryError('STALE_MEMORY_VERSION', 'Le souvenir a été modifié entre-temps : recharge-le', { currentVersion: row.version }); }
  function mustGet(id) { const r = db().prepare('SELECT * FROM dmem_items WHERE memory_id = ?').get(id); if (!r) throw new MemoryError('MEMORY_NOT_FOUND', 'Souvenir introuvable'); return r; }

  async function edit(id, o = {}) {
    const row = mustGet(id);
    if (row.status !== 'APPROVED') throw new MemoryError('INVALID_STATUS', `Un souvenir ${row.status} ne peut pas être modifié`);
    lockCheck(row, o.expectedVersion);
    const type = o.type ?? row.type; const scope = o.scope ? validateScope(o.scope, type, o) : { kind: row.scope_kind, projectId: row.project_id || null, notebookId: row.notebook_id || null };
    const prepared = prepareStatement(o.statement ?? row.statement, type, { ...o, sensitivity: o.sensitivity ?? row.sensitivity });
    if (prepared.statement === row.statement && type === row.type && !o.scope && !o.sensitivity) return { memory: rowToItem(row), unchanged: true };
    if (!o.allowDuplicate && prepared.statement !== row.statement) { const dup = findDuplicate(prepared.statement, scope); if (dup && dup.memoryId !== id) throw new MemoryError('DUPLICATE_MEMORY', 'Un souvenir identique existe déjà dans ce scope', { duplicateOf: dup.memoryId }); }
    const version = row.version + 1; const t = nowIso();
    db().transaction(() => {
      // optimistic lock in SQL as well: a concurrent writer cannot be overwritten
      const r = db().prepare(`UPDATE dmem_items SET statement = ?, type = ?, scope_kind = ?, project_id = ?, notebook_id = ?, sensitivity = ?, injection_flags = ?, norm_key = ?, statement_hash = ?, version = ?, updated_at = ?
        WHERE memory_id = ? AND version = ? AND status = 'APPROVED'`).run(prepared.statement, type, scope.kind, scope.projectId ?? '', scope.notebookId ?? '', o.sensitivity ?? row.sensitivity, JSON.stringify(prepared.injection), keyOf(prepared.statement), sha(prepared.statement), version, t, id, row.version);
      if (r.changes !== 1) throw new MemoryError('STALE_MEMORY_VERSION', 'Le souvenir a été modifié entre-temps', { currentVersion: mustGet(id).version });
      revision(id, version, 'EDIT', { oldStatement: row.statement, newStatement: prepared.statement, oldStatus: row.status, newStatus: row.status });
      audit(id, 'EDIT');
      ftsDelete(id); ftsInsert({ ...row, statement: prepared.statement, type, project_id: scope.projectId ?? '', scope_kind: scope.kind });
      db().prepare('DELETE FROM dmem_embeddings WHERE memory_id = ?').run(id); // the old embedding is stale from this instant: never used again
      db().prepare(`DELETE FROM dmem_conflicts WHERE (memory_a = ? OR memory_b = ?) AND status = 'OPEN'`).run(id, id);
      db().prepare(`DELETE FROM dmem_suggestions WHERE (new_id = ? OR old_id = ?) AND status = 'PENDING'`).run(id, id);
    })();
    await vectorStore.delete([id]).catch(() => {}); // old vector removed before the new one is written
    const fin = await finalize(id);
    return { memory: getMemory(id), ...fin, redacted: prepared.redacted };
  }

  async function revoke(id, o = {}) {
    const row = mustGet(id);
    if (row.status === 'REVOKED') throw new MemoryError('INVALID_STATUS', 'Déjà révoqué');
    lockCheck(row, o.expectedVersion);
    const version = row.version + 1; const t = nowIso();
    db().transaction(() => {
      const r = db().prepare(`UPDATE dmem_items SET status = 'REVOKED', effective_until = ?, version = ?, updated_at = ? WHERE memory_id = ? AND version = ?`).run(t, version, t, id, row.version);
      if (r.changes !== 1) throw new MemoryError('STALE_MEMORY_VERSION', 'Le souvenir a été modifié entre-temps', { currentVersion: mustGet(id).version });
      revision(id, version, 'REVOKE', { oldStatus: row.status, newStatus: 'REVOKED', reason: o.reason ?? null }); audit(id, 'REVOKE', 'user', row.status, 'REVOKED');
      ftsDelete(id); db().prepare('DELETE FROM dmem_embeddings WHERE memory_id = ?').run(id);
      db().prepare(`UPDATE dmem_conflicts SET status = 'RESOLVED', resolution = 'REVOKED', resolved_at = ? WHERE (memory_a = ? OR memory_b = ?) AND status = 'OPEN'`).run(t, id, id);
      db().prepare(`UPDATE dmem_suggestions SET status = 'DISMISSED', decided_at = ? WHERE (new_id = ? OR old_id = ?) AND status = 'PENDING'`).run(t, id, id);
    })();
    await vectorStore.delete([id]).catch(() => {}); // active retrieval of a revoked memory is 0 — in FTS and vectors alike
    return { memory: getMemory(id) };
  }

  function setArchived(id, archived, o = {}) {
    const row = mustGet(id);
    const from = archived ? 'APPROVED' : 'ARCHIVED'; const to = archived ? 'ARCHIVED' : 'APPROVED';
    if (row.status !== from) throw new MemoryError('INVALID_STATUS', `${archived ? 'Archiver' : 'Restaurer'} exige le statut ${from}`);
    lockCheck(row, o.expectedVersion);
    const version = row.version + 1; const t = nowIso();
    db().transaction(() => {
      const r = db().prepare('UPDATE dmem_items SET status = ?, effective_until = ?, version = ?, updated_at = ? WHERE memory_id = ? AND version = ?').run(to, archived ? t : null, version, t, id, row.version);
      if (r.changes !== 1) throw new MemoryError('STALE_MEMORY_VERSION', 'Le souvenir a été modifié entre-temps', { currentVersion: mustGet(id).version });
      revision(id, version, archived ? 'ARCHIVE' : 'RESTORE', { oldStatus: from, newStatus: to }); audit(id, archived ? 'ARCHIVE' : 'RESTORE', 'user', from, to);
    })();
    return { memory: getMemory(id) };
  }

  // Hard purge: rows, FTS, embedding metadata, usage references, conflicts, suggestions, revisions, evidence, vector. Audit keeps ids only.
  async function deleteMemory(id, { actor = 'user', expectedVersion } = {}) {
    const row = mustGet(id);
    lockCheck(row, expectedVersion);
    db().transaction(() => {
      for (const t of ['dmem_evidence', 'dmem_revisions', 'dmem_usage', 'dmem_embeddings']) db().prepare(`DELETE FROM ${t} WHERE memory_id = ?`).run(id);
      db().prepare('DELETE FROM dmem_conflicts WHERE memory_a = ? OR memory_b = ?').run(id, id);
      db().prepare('DELETE FROM dmem_suggestions WHERE new_id = ? OR old_id = ?').run(id, id);
      ftsDelete(id);
      db().prepare('UPDATE dmem_items SET superseded_by = NULL, needs_review = 1 WHERE superseded_by = ?').run(id); // an old memory whose replacement disappeared asks for review
      db().prepare('DELETE FROM dmem_items WHERE memory_id = ?').run(id);
      audit(id, 'DELETE', actor, row.status, null);
    })();
    await vectorStore.delete([id]).catch(() => {});
    return { ok: true };
  }

  // ── supersession (suggested by the system, CONFIRMED by a human) ──────────
  const overlap = (a, b) => { const A = new Set(a); const B = new Set(b); const inter = [...A].filter(x => B.has(x)).length; return { inter, coeff: inter / (Math.min(A.size, B.size) || 1) }; };
  function scopesOverlap(a, b) {
    if (a.scope_kind === 'GLOBAL' || b.scope_kind === 'GLOBAL') return true;
    const pa = a.scope_kind === 'PROJECT' ? a.project_id : projectOfNotebook(a.notebook_id); const pb = b.scope_kind === 'PROJECT' ? b.project_id : projectOfNotebook(b.notebook_id);
    if (a.scope_kind === 'NOTEBOOK' && b.scope_kind === 'NOTEBOOK') return a.notebook_id === b.notebook_id;
    return !!pa && pa === pb;
  }
  function addSuggestion(newId_, oldId, ambiguous, detail) {
    if (newId_ === oldId) return;
    db().prepare(`INSERT OR IGNORE INTO dmem_suggestions (suggestion_id, new_id, old_id, ambiguous, detail, status, created_at) VALUES (?,?,?,?,?,'PENDING',?)`).run(newId('nsug'), newId_, oldId, ambiguous ? 1 : 0, detail, nowIso());
  }
  const SUPERSEDE_CUE = /(?:remplac\w+|replace|switch(?:ing)?(?: from)?|abandon\w*|instead of|plutôt que|au lieu de)\s+(.{3,60}?)\s+(?:par|by|with|to|pour|,)\s+/iu;
  function suggestSupersessions(id) {
    const m = mustGet(id); if (m.status !== 'APPROVED' || !SUPERSEDABLE.has(m.type)) return 0;
    const mt = queryTerms(m.statement); const explicit = SUPERSEDE_CUE.exec(m.statement); const xTerms = explicit ? queryTerms(explicit[1]) : null;
    const others = db().prepare(`SELECT * FROM dmem_items WHERE status = 'APPROVED' AND type = ? AND memory_id != ?`).all(m.type, id); let n = 0;
    for (const o of others) {
      if (!scopesOverlap(m, o) || o.effective_from >= m.effective_from) continue; // the suggested replacement must be strictly newer
      const { inter, coeff } = overlap(mt, queryTerms(o.statement));
      const isExplicit = xTerms?.length && overlap(xTerms, queryTerms(o.statement)).coeff >= 0.75;
      if (isExplicit) { addSuggestion(id, o.memory_id, false, 'remplacement explicite dans la formulation'); n++; }
      else if (inter >= 2 && coeff >= 0.5 && shingleJaccard(m.statement, o.statement) < 0.8) { addSuggestion(id, o.memory_id, true, 'même sujet, formulation différente, date plus récente — à vérifier'); n++; }
    }
    return n;
  }
  const listSuggestions = ({ status = 'PENDING', limit = 100 } = {}) => db().prepare(`SELECT * FROM dmem_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit).map(r => ({
    suggestionId: r.suggestion_id, newId: r.new_id, oldId: r.old_id, ambiguous: r.ambiguous === 1, detail: r.detail, status: r.status, createdAt: r.created_at, newMemory: getMemory(r.new_id), oldMemory: getMemory(r.old_id) }));

  // Human decision: the OLD memory becomes SUPERSEDED (kept, dated), the NEW one stays APPROVED. Never automatic.
  async function confirmSupersession(newMemoryId, oldMemoryId, o = {}) {
    if (o.confirm !== true) throw new MemoryError('APPROVAL_REQUIRED', 'Une supersession exige une confirmation explicite (confirm: true)', { field: 'confirm' });
    const nw = mustGet(newMemoryId); const old = mustGet(oldMemoryId);
    if (nw.status !== 'APPROVED') throw new MemoryError('INVALID_STATUS', 'Le remplaçant doit être APPROVED');
    if (old.status !== 'APPROVED') throw new MemoryError('INVALID_STATUS', `L'ancien souvenir est déjà ${old.status}`);
    if (newMemoryId === oldMemoryId) throw new MemoryError('INVALID_OPTION', 'Un souvenir ne se remplace pas lui-même');
    lockCheck(old, o.expectedOldVersion);
    const t = nowIso(); const until = nw.effective_from > old.effective_from ? nw.effective_from : t; const version = old.version + 1;
    db().transaction(() => {
      const r = db().prepare(`UPDATE dmem_items SET status = 'SUPERSEDED', effective_until = ?, superseded_by = ?, version = ?, updated_at = ? WHERE memory_id = ? AND version = ? AND status = 'APPROVED'`).run(until, newMemoryId, version, t, oldMemoryId, old.version);
      if (r.changes !== 1) throw new MemoryError('INVALID_STATUS', 'Supersession concurrente : l\'ancien souvenir a changé', { currentVersion: mustGet(oldMemoryId).version });
      revision(oldMemoryId, version, 'SUPERSEDE', { oldStatus: 'APPROVED', newStatus: 'SUPERSEDED', reason: `remplacé par ${newMemoryId}` }); audit(oldMemoryId, 'SUPERSEDE', 'user', 'APPROVED', 'SUPERSEDED');
      db().prepare(`UPDATE dmem_suggestions SET status = 'CONFIRMED', decided_at = ? WHERE new_id = ? AND old_id = ?`).run(t, newMemoryId, oldMemoryId);
      db().prepare(`UPDATE dmem_conflicts SET status = 'RESOLVED', resolution = 'SUPERSEDED', resolved_at = ? WHERE status = 'OPEN' AND ((memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?))`).run(t, oldMemoryId, newMemoryId, newMemoryId, oldMemoryId);
    })();
    return { old: getMemory(oldMemoryId), new: getMemory(newMemoryId) };
  }
  function dismissSupersession(newMemoryId, oldMemoryId) {
    const r = db().prepare(`UPDATE dmem_suggestions SET status = 'DISMISSED', decided_at = ? WHERE new_id = ? AND old_id = ? AND status = 'PENDING'`).run(nowIso(), newMemoryId, oldMemoryId);
    return { ok: r.changes === 1 };
  }

  // ── conflicts (surfaced, never silently resolved) ─────────────────────────
  function toConflictObj(r, n) { return { citationId: n, chunkId: r.memory_id, sourceId: r.memory_id, documentId: r.memory_id, sourceTitle: r.type, documentVersion: 1, text: r.statement, importedAt: r.effective_from }; }
  function detectConflictsFor(id) {
    const m = mustGet(id); if (m.status !== 'APPROVED') return 0;
    const terms = queryTerms(m.statement); if (!terms.length) return 0;
    const cands = db().prepare(`SELECT * FROM dmem_items WHERE status = 'APPROVED' AND memory_id != ?`).all(id).filter(o => scopesOverlap(m, o) && overlap(terms, queryTerms(o.statement)).inter >= 1);
    let n = 0;
    for (const o of cands) {
      const found = detectConflicts([toConflictObj(m, 1), toConflictObj(o, 2)], { minTopicOverlap: 0.34 });
      if (!found.length) continue;
      const [a, b] = [m.memory_id, o.memory_id].sort();
      const r = db().prepare(`INSERT OR IGNORE INTO dmem_conflicts (conflict_id, memory_a, memory_b, kind, detail, status, detected_at) VALUES (?,?,?,?,?,'OPEN',?)`).run(newId('ncon'), a, b, found[0].type, `${found[0].detail ?? found[0].type} (heuristique)`, nowIso());
      if (r.changes) n++;
    }
    return n;
  }
  const listConflicts = ({ status = 'OPEN', limit = 100 } = {}) => db().prepare('SELECT * FROM dmem_conflicts WHERE status = ? ORDER BY detected_at DESC LIMIT ?').all(status, limit).map(r => ({
    conflictId: r.conflict_id, memoryA: r.memory_a, memoryB: r.memory_b, kind: r.kind, detail: r.detail, status: r.status, resolution: r.resolution, detectedAt: r.detected_at, a: getMemory(r.memory_a), b: getMemory(r.memory_b) }));
  // action: KEEP_BOTH (dismiss) | SUPERSEDE_A (B replaces A… see below) | REVOKE_A | REVOKE_B — always a human choice
  async function resolveConflict(conflictId, action, o = {}) {
    const c = db().prepare('SELECT * FROM dmem_conflicts WHERE conflict_id = ?').get(conflictId);
    if (!c) throw new MemoryError('MEMORY_NOT_FOUND', 'Conflit introuvable');
    if (c.status !== 'OPEN') throw new MemoryError('INVALID_STATUS', 'Conflit déjà traité');
    if (action === 'KEEP_BOTH') { db().prepare(`UPDATE dmem_conflicts SET status = 'RESOLVED', resolution = 'KEEP_BOTH', resolved_at = ? WHERE conflict_id = ?`).run(nowIso(), conflictId); return { ok: true }; }
    if (action === 'REVOKE_A' || action === 'REVOKE_B') { await revoke(action === 'REVOKE_A' ? c.memory_a : c.memory_b, { reason: 'conflit' }); return { ok: true }; }
    if (action === 'A_SUPERSEDES_B' || action === 'B_SUPERSEDES_A') {
      const [nw, old] = action === 'A_SUPERSEDES_B' ? [c.memory_a, c.memory_b] : [c.memory_b, c.memory_a];
      await confirmSupersession(nw, old, { confirm: o.confirm === true }); return { ok: true };
    }
    throw new MemoryError('INVALID_OPTION', `action de résolution inconnue : ${action}`);
  }
  const openConflictsAmong = (ids) => {
    if (ids.length < 2) return [];
    const ph = ids.map(() => '?').join(',');
    return db().prepare(`SELECT * FROM dmem_conflicts WHERE status = 'OPEN' AND memory_a IN (${ph}) AND memory_b IN (${ph})`).all(...ids, ...ids).map(r => ({ conflictId: r.conflict_id, kind: r.kind, memoryA: r.memory_a, memoryB: r.memory_b, detail: r.detail }));
  };

  // ── reads ─────────────────────────────────────────────────────────────────
  function getMemory(id) { return rowToItem(db().prepare('SELECT * FROM dmem_items WHERE memory_id = ?').get(id)); }
  // A memory is only handed out for a context that may see it (project isolation on direct access as well).
  function getMemoryForContext(id, ctx = {}) {
    const m = getMemory(id); if (!m) throw new MemoryError('MEMORY_NOT_FOUND', 'Souvenir introuvable');
    const c = resolveContext(ctx);
    if (m.scopeKind === 'PROJECT' && m.projectId !== c.projectId) throw new MemoryError('CROSS_PROJECT_DENIED', 'Ce souvenir appartient à un autre projet');
    if (m.scopeKind === 'NOTEBOOK' && m.notebookId !== c.notebookId) throw new MemoryError('CROSS_PROJECT_DENIED', 'Ce souvenir est limité à un autre Notebook');
    return m;
  }
  function listMemories({ status = null, scopeKind = null, projectId = null, notebookId = null, type = null, q = null, needsReview = null, limit = 50, offset = 0 } = {}) {
    let sql = `SELECT * FROM dmem_items m WHERE ${vis().sql}`; const p = [...vis().params];
    if (status) { sql += ' AND m.status = ?'; p.push(status); }
    if (scopeKind) { sql += ' AND m.scope_kind = ?'; p.push(scopeKind); }
    if (projectId) { sql += ' AND m.project_id = ?'; p.push(projectId); }
    if (notebookId) { sql += ' AND m.notebook_id = ?'; p.push(notebookId); }
    if (type) { sql += ' AND m.type = ?'; p.push(type); }
    if (needsReview != null) { sql += ' AND m.needs_review = ?'; p.push(needsReview ? 1 : 0); }
    if (q) { sql += " AND m.statement LIKE ? ESCAPE '\\'"; p.push(`%${String(q).replace(/[%_\\]/g, x => `\\${x}`)}%`); }
    sql += ' ORDER BY m.updated_at DESC, m.memory_id LIMIT ? OFFSET ?'; p.push(limit, offset);
    return db().prepare(sql).all(...p).map(rowToItem);
  }
  const countMemories = (status = null) => (status ? db().prepare('SELECT COUNT(*) n FROM dmem_items WHERE status = ?').get(status).n : db().prepare('SELECT COUNT(*) n FROM dmem_items').get().n);
  const listEvidence = (id) => db().prepare('SELECT * FROM dmem_evidence WHERE memory_id = ? ORDER BY ts').all(id).map(r => ({ kind: r.kind, ref: r.ref, sourceId: r.source_id, conversationId: r.conversation_id, provider: r.provider, role: r.role, trustLevel: r.trust_level, quote: r.quote, ts: r.ts, status: r.status }));
  const listRevisions = (id) => db().prepare('SELECT * FROM dmem_revisions WHERE memory_id = ? ORDER BY version, at').all(id).map(r => ({ revisionId: r.revision_id, version: r.version, action: r.action, oldStatement: r.old_statement, newStatement: r.new_statement, oldStatus: r.old_status, newStatus: r.new_status, reason: r.reason, at: r.at }));

  // ── retention (bounded, local) ────────────────────────────────────────────
  async function sweepRetention({ limit = 100 } = {}) {
    const expired = db().prepare(`SELECT memory_id FROM dmem_items WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?`).all(nowIso(), limit).map(r => r.memory_id);
    const stale = db().prepare(`SELECT memory_id FROM dmem_items WHERE retention = 'SESSION_ONLY' AND (session_id IS NULL OR session_id != ?) LIMIT ?`).all(sessionId, limit).map(r => r.memory_id);
    for (const id of [...expired, ...stale]) { try { await deleteMemory(id, { actor: 'retention' }); } catch { /* already gone */ } }
    return { expired: expired.length, staleSession: stale.length };
  }
  try { ensureMemorySchema(db()); } catch { /* DB not ready: the document service creates the same idempotent schema */ }
  const ready = sweepRetention({ limit: 1000 }).catch(() => ({}));
  let timer = null;
  const startRetentionJob = (ms = deps.retentionSweepMs ?? 0) => { if (timer || !ms) return; timer = setInterval(() => { void sweepRetention().catch(() => {}); }, Math.max(60_000, ms)); timer.unref?.(); };
  startRetentionJob();

  // ── embeddings status / explicit reindex ──────────────────────────────────
  function vectorStatus() {
    const r = db().prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN e.memory_id IS NULL THEN 1 ELSE 0 END) missing,
        SUM(CASE WHEN e.memory_id IS NOT NULL AND e.provider = ? AND e.model = ? AND e.embed_version = ? AND e.statement_hash = m.statement_hash THEN 1 ELSE 0 END) compatible
      FROM dmem_items m LEFT JOIN dmem_embeddings e ON e.memory_id = m.memory_id WHERE m.status != 'REVOKED'`).get(provider, model, embedFormat.version);
    const total = r.total ?? 0; const missing = r.missing ?? 0; const compatible = r.compatible ?? 0;
    return { total, missing, compatible, incompatible: total - missing - compatible, needsReindex: total - compatible > 0, provider, model, embedVersion: embedFormat.version };
  }
  async function reindexMemories({ limit = 2000 } = {}) {
    const ids = db().prepare(`SELECT m.memory_id FROM dmem_items m LEFT JOIN dmem_embeddings e ON e.memory_id = m.memory_id
      WHERE m.status != 'REVOKED' AND (e.memory_id IS NULL OR e.provider != ? OR e.model != ? OR e.embed_version != ? OR e.statement_hash != m.statement_hash) LIMIT ?`).all(provider, model, embedFormat.version, limit).map(r => r.memory_id);
    let ok = 0; let failed = 0;
    for (const id of ids) { const s = await indexVector(id); if (s === 'READY') ok++; else if (s === 'VECTOR_UNAVAILABLE') failed++; }
    return { ok: failed === 0, reindexed: ok, failed, considered: ids.length };
  }

  // ── contextual retrieval ──────────────────────────────────────────────────
  function statusWhere({ includeHistorical, asOf }) {
    if (asOf) return { sql: `m.status IN ('APPROVED','SUPERSEDED','ARCHIVED') AND m.effective_from <= ? AND (m.effective_until IS NULL OR m.effective_until > ?)`, params: [asOf, asOf] };
    if (includeHistorical) return { sql: `m.status IN ('APPROVED','SUPERSEDED','ARCHIVED')`, params: [] };
    return { sql: `m.status = 'APPROVED' AND m.effective_from <= ? AND (m.effective_until IS NULL OR m.effective_until > ?)`, params: [nowIso(), nowIso()] };
  }
  function scopeWhere(ctx) {
    const parts = [`m.scope_kind = 'GLOBAL'`]; const params = [];
    if (ctx.projectId) { parts.push(`(m.scope_kind = 'PROJECT' AND m.project_id = ?)`); params.push(ctx.projectId); }
    if (ctx.notebookId) { parts.push(`(m.scope_kind = 'NOTEBOOK' AND m.notebook_id = ?)`); params.push(ctx.notebookId); }
    return { sql: `(${parts.join(' OR ')})`, params };
  }
  function sensitivityList(o) { return ['NORMAL', ...(o.includeSensitive || o.includeHighlySensitive ? ['SENSITIVE'] : []), ...(o.includeHighlySensitive ? ['HIGHLY_SENSITIVE'] : [])]; }

  function searchFtsMem(terms, ctx, o, limit) {
    const match = terms.map(t => `"${t}"`).join(' OR '); if (!match) return [];
    const st = statusWhere(o); const sc = scopeWhere(ctx); const v = vis(); const sens = sensitivityList(o);
    let sql = `SELECT m.*, bm25(dmem_items_fts, 1.0, 0.5, 0.5) AS bm25 FROM dmem_items_fts f JOIN dmem_items m ON m.memory_id = f.memory_id
      WHERE dmem_items_fts MATCH ? AND ${st.sql} AND ${sc.sql} AND ${v.sql} AND m.sensitivity IN (${sens.map(() => '?').join(',')})`;
    const params = [match, ...st.params, ...sc.params, ...v.params, ...sens];
    if (Array.isArray(o.types) && o.types.length) { sql += ` AND m.type IN (${o.types.map(() => '?').join(',')})`; params.push(...o.types); }
    sql += ' ORDER BY bm25 LIMIT ?'; params.push(limit);
    return db().prepare(sql).all(...params).map(r => ({ ...rowToItem(r), bm25: r.bm25 }));
  }
  function hydrateMem(ids, ctx, o) {
    if (!ids.length) return new Map();
    const st = statusWhere(o); const sc = scopeWhere(ctx); const v = vis(); const sens = sensitivityList(o);
    const rows = db().prepare(`SELECT m.* FROM dmem_items m WHERE m.memory_id IN (${ids.map(() => '?').join(',')}) AND ${st.sql} AND ${sc.sql} AND ${v.sql} AND m.sensitivity IN (${sens.map(() => '?').join(',')})`)
      .all(...ids, ...st.params, ...sc.params, ...v.params, ...sens).map(rowToItem);
    const typed = Array.isArray(o.types) && o.types.length ? rows.filter(r => o.types.includes(r.type)) : rows;
    return new Map(typed.map(r => [r.memoryId, r]));
  }

  async function retrieve(query, o = {}) {
    const q = String(query ?? '').trim();
    const requestId = o.requestId ?? newId('nreq');
    const cfg = resolveRetrievalConfig(baseCfg, o.config, o.topK ? { topK: o.topK } : null);
    const empty = (notice, extra = {}) => ({ pack: buildMemoryContextPack({ requestId, query: null, memories: [], notice }), results: [], retrievalMode: 'FTS_ONLY', vectorStatus: 'NOT_USED', diagnostics: extra, requestId });
    if (!q) return empty('EMPTY_QUERY');
    await sweepRetention({ limit: 20 });
    const ctx = resolveContext(o);
    const historical = !!(o.includeHistorical || o.asOf);
    if (o.asOf && Number.isNaN(Date.parse(o.asOf))) throw new MemoryError('INVALID_OPTION', 'asOf invalide');
    const asOf = o.asOf ? new Date(o.asOf).toISOString() : null;
    const opts = { ...o, asOf };
    const pool = Math.max(cfg.topK * cfg.poolMultiplier, 20);
    const terms = memoryQueryTerms(q);

    const ftsRaw = terms.length ? searchFtsMem(terms, ctx, opts, pool) : [];
    const ftsHits = gateFtsHits(ftsRaw.map(h => ({ ...h, chunkId: h.memoryId, text: h.statement, title: `${h.type.replace(/_/g, ' ')} ${h.projectId ?? ''}`, hash: h.memoryId })), terms, cfg);

    let vectorState = 'NOT_USED'; let vecHits = [];
    // vectorMode (NB-7): 'hybrid' (default, NB-5) | 'fallback' (embed the query only when FTS found nothing) | 'off'.
    const vectorWanted = o.useVector !== false && o.vectorMode !== 'off' && !(o.vectorMode === 'fallback' && ftsHits.length > 0);
    if (vectorWanted) {
      try {
        const qv = await embedQuery(q);
        const raw = await vectorStore.search(qv, { scopes: { projectId: ctx.projectId, notebookId: ctx.notebookId }, limit: pool });
        const metas = new Map(); const ids = raw.map(r => r.memory_id);
        for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); for (const r of db().prepare(`SELECT * FROM dmem_embeddings WHERE memory_id IN (${part.map(() => '?').join(',')})`).all(...part)) metas.set(r.memory_id, r); }
        const items = hydrateMem(ids, ctx, opts);
        // never compare vectors across provider / model / dimension / format / and never with a STALE statement embedding
        const compatible = raw.filter(r => { const e = metas.get(r.memory_id); const it = items.get(r.memory_id); return e && it && e.provider === provider && e.model === model && e.embed_version === embedFormat.version && e.dimension === qv.length && e.statement_hash === sha(it.statement); });
        vecHits = compatible.map(r => ({ ...items.get(r.memory_id), chunkId: r.memory_id, text: items.get(r.memory_id).statement, hash: r.memory_id, vectorScore: r.score })).sort((a, b) => b.vectorScore - a.vectorScore);
        if (raw.length && !compatible.length) vectorState = 'VECTOR_STALE'; else vectorState = 'READY';
      } catch { vectorState = 'VECTOR_UNAVAILABLE'; }
    }
    const gatedVec = gateVectorHits(vecHits, cfg, new Set(ftsHits.map(h => h.chunkId)));
    let ranked = fuseRanked(ftsHits, gatedVec, cfg);
    // contextual precedence: more specific scope first (ordering only — never authority)
    for (const e of ranked) e.score *= cfg.scopeBoost[e.chunk.scopeKind] ?? 1;
    ranked.sort((a, b) => b.score - a.score || a.chunk.memoryId.localeCompare(b.chunk.memoryId));
    const picked = []; const tokens = { used: 0 };
    for (const e of ranked) {
      if (picked.length >= cfg.topK) break;
      if (picked.some(p => shingleJaccard(p.chunk.statement, e.chunk.statement) >= cfg.nearDuplicateJaccard && p.chunk.scopeKind === e.chunk.scopeKind)) continue; // no double injection of the same statement
      const t = estimateTokens(e.chunk.statement); if (picked.length && tokens.used + t > cfg.maxContextTokens) break; tokens.used += t; picked.push(e);
    }
    const results = picked.map(e => ({ ...getMemory(e.chunk.memoryId), score: e.score, ftsRank: e.ftsRank, vectorRank: e.vectorRank }));
    const ids = results.map(r => r.memoryId);
    const conflicts = openConflictsAmong(ids);
    if (o.strictConflicts && conflicts.length) throw new MemoryError('CONFLICT_REVIEW_REQUIRED', 'Des souvenirs récupérés sont en conflit : revue requise', { conflicts });
    const notice = ctx.projectSource === null && (o.activeProject == null) ? 'PROJECT_UNRESOLVED_NO_PROJECT_MEMORY' : null;
    const pack = buildMemoryContextPack({ requestId, query: null, memories: results, conflicts, notice: results.length ? notice : (notice ?? 'NO_RELEVANT_MEMORY'), historical });
    if (o.trace && results.length) recordUsage(requestId, results.map(r => ({ memoryId: r.memoryId, score: r.score, reason: r.ftsRank != null && r.vectorRank != null ? 'HYBRID' : r.ftsRank != null ? 'FTS' : 'VECTOR' })));
    return { pack, results, retrievalMode: vectorState === 'READY' ? 'HYBRID' : 'FTS_ONLY', vectorStatus: vectorState, diagnostics: { terms, ftsCandidates: ftsRaw.length, ftsAfterGate: ftsHits.length, vectorAfterGate: gatedVec.length, project: ctx.projectId, projectSource: ctx.projectSource }, requestId, context: ctx };
  }

  // ── usage trace (no conversation content) ─────────────────────────────────
  function recordUsage(requestId, items) {
    const st = db().prepare('INSERT INTO dmem_usage (memory_id, request_id, at, score, reason) VALUES (?,?,?,?,?)'); const t = nowIso();
    db().transaction(() => { for (const i of items) st.run(i.memoryId, requestId, t, i.score ?? null, i.reason ?? null); })();
    // bounded: keep the newest 20 000 usage rows
    const n = db().prepare('SELECT COUNT(*) n FROM dmem_usage').get().n; if (n > 25_000) db().prepare('DELETE FROM dmem_usage WHERE usage_id IN (SELECT usage_id FROM dmem_usage ORDER BY usage_id LIMIT ?)').run(n - 20_000);
  }
  const listUsage = (requestId) => db().prepare('SELECT u.*, m.statement, m.status, m.scope_kind FROM dmem_usage u LEFT JOIN dmem_items m ON m.memory_id = u.memory_id WHERE u.request_id = ? ORDER BY u.usage_id').all(requestId).map(r => ({ memoryId: r.memory_id, requestId: r.request_id, at: r.at, score: r.score, reason: r.reason, statement: r.statement ?? null, status: r.status ?? null, scopeKind: r.scope_kind ?? null }));
  const usageCount = (memoryId) => db().prepare('SELECT COUNT(*) n FROM dmem_usage WHERE memory_id = ?').get(memoryId).n;

  // ── answer pipeline: memory ▸ (optional) Notebook sources ▸ context pack ▸ local LLM ───────────────
  async function answer(question, o = {}) {
    const requestId = o.requestId ?? newId('nreq');
    const mem = await retrieve(question, { ...o, requestId, trace: false });
    let notebook = { results: [] };
    if (o.useNotebook && o.activeNotebook && deps.notebookSearch) notebook = await deps.notebookSearch(o.activeNotebook, question, { topK: o.notebookTopK ?? 4 });
    const extra = [];
    if (notebook.results?.length) extra.push(notebook.sourcesBlock ?? '');
    const { messages } = buildMemoryMessages(mem.pack, String(question), { extraSystemBlocks: extra.filter(Boolean) });
    const text = String(await deps.localComplete(messages) ?? '');
    const used = new Set(); const re = /\[M(\d+)\]/g; let m;
    while ((m = re.exec(text)) !== null) { const i = Number(m[1]) - 1; if (i >= 0 && i < mem.results.length) used.add(i); }
    const memoryCitations = [...used].sort((a, b) => a - b).map(i => ({ marker: `M${i + 1}`, memoryId: mem.results[i].memoryId, statement: mem.results[i].statement }));
    if (mem.results.length) recordUsage(requestId, mem.results.map(r => ({ memoryId: r.memoryId, score: r.score, reason: 'INJECTED' })));
    return {
      requestId, answer: text, memoryUsed: mem.results.map((r, i) => ({ marker: `M${i + 1}`, memoryId: r.memoryId, type: r.type, scope: r.scope, status: r.status, statement: r.statement })), memoryCitations,
      conflicts: mem.pack.conflicts, notice: mem.pack.notice, retrievalMode: mem.retrievalMode, vectorStatus: mem.vectorStatus, notebookSources: notebook.results ?? [],
      authority: 'CONTEXT_ONLY',
    };
  }

  return {
    createProject, listProjects, getProject, setNotebookProject, projectOfNotebook, resolveContext,
    promoteCandidate, promoteMerged, proposeMerges, createManual, edit, revoke, archive: async (id, o) => setArchived(id, true, o), restore: async (id, o) => setArchived(id, false, o), deleteMemory,
    getMemory, getMemoryForContext, listMemories, countMemories, listEvidence, listRevisions,
    listSuggestions, confirmSupersession, dismissSupersession, listConflicts, resolveConflict,
    retrieve, answer, recordUsage, listUsage, usageCount, vectorStatus, reindexMemories, indexVector,
    sweepRetention, startRetentionJob, stopRetentionJob: () => { if (timer) clearInterval(timer); timer = null; }, ready,
    sessionId, embedFormat, retrievalConfig: baseCfg,
    constants: { MEMORY_TYPES, MEMORY_STATUSES, SCOPE_KINDS, SENSITIVITIES, MEMORY_RETENTIONS, MAX_STATEMENT_CHARS },
  };
}

export { MEMORY_SYSTEM_PROMPT };
void TRUST_LEVELS;
