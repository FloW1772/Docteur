// Notebook NB-4 — SQLite persistence helpers for AI histories (schema: notebook-ai-schema.js).
// All queries are notebook-scoped and honour NB-3 visibility (retention / session / READY-only).

import crypto from 'node:crypto';
import { getDatabase } from './sqlite.js';
import { purgeAiImportRows } from './notebook-ai-schema.js';

const now = () => new Date().toISOString();
const pj = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export const newImportId = () => `nimp-${crypto.randomUUID()}`;
export const newCandidateId = () => `ncand-${crypto.randomUUID()}`;

const VIS = `(d.expires_at IS NULL OR d.expires_at > ?) AND (d.retention != 'SESSION_ONLY' OR d.session_id = ?) AND d.status = 'READY'`;

// ── imports ─────────────────────────────────────────────────────────────────
const importRow = (r) => r && ({
  importId: r.import_id, notebookId: r.notebook_id, provider: r.provider, adapter: r.adapter, providerVerified: r.provider_verified === 1,
  sourceName: r.source_name, fileHash: r.file_hash, size: r.size, status: r.status, distillStatus: r.distill_status, errorCode: r.error_code,
  secretPolicy: r.secret_policy, counts: pj(r.counts, {}), findings: pj(r.findings, []), createdAt: r.created_at, updatedAt: r.updated_at,
  retention: r.retention ?? null, expiresAt: r.expires_at ?? null,
});
export function insertImport(i) {
  getDatabase().prepare(`INSERT INTO nb_ai_imports (import_id, notebook_id, provider, adapter, provider_verified, source_name, file_hash, size, status, secret_policy, counts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(i.importId, i.notebookId, i.provider ?? 'UNKNOWN', i.adapter ?? '', i.providerVerified ? 1 : 0, i.sourceName ?? '', i.fileHash ?? '', i.size ?? 0, i.status ?? 'QUEUED', i.secretPolicy ?? 'block', JSON.stringify(i.counts ?? {}), now(), now());
}
export function updateImport(importId, f) {
  const map = { provider: 'provider', adapter: 'adapter', status: 'status', distillStatus: 'distill_status', errorCode: 'error_code', fileHash: 'file_hash', size: 'size' };
  const sets = []; const vals = [];
  for (const [k, c] of Object.entries(map)) if (k in f) { sets.push(`${c} = ?`); vals.push(f[k]); }
  if ('providerVerified' in f) { sets.push('provider_verified = ?'); vals.push(f.providerVerified ? 1 : 0); }
  if ('counts' in f) { sets.push('counts = ?'); vals.push(JSON.stringify(f.counts)); }
  if ('findings' in f) { sets.push('findings = ?'); vals.push(JSON.stringify(f.findings)); }
  if (!sets.length) return; sets.push('updated_at = ?'); vals.push(now());
  getDatabase().prepare(`UPDATE nb_ai_imports SET ${sets.join(', ')} WHERE import_id = ?`).run(...vals, importId);
}
export function getImport(importId) {
  return importRow(getDatabase().prepare(`SELECT i.*, d.retention, d.expires_at FROM nb_ai_imports i LEFT JOIN nb_documents d ON d.document_id = i.import_id WHERE i.import_id = ?`).get(importId));
}
export function listImports(notebookId, { limit = 50, offset = 0 } = {}) {
  return getDatabase().prepare(`SELECT i.*, d.retention, d.expires_at FROM nb_ai_imports i LEFT JOIN nb_documents d ON d.document_id = i.import_id WHERE i.notebook_id = ? ORDER BY i.created_at DESC LIMIT ? OFFSET ?`).all(notebookId, limit, offset).map(importRow);
}
export function countImports(notebookId) { return getDatabase().prepare('SELECT COUNT(*) n FROM nb_ai_imports WHERE notebook_id = ?').get(notebookId).n; }
export function findImportByHash(notebookId, fileHash) {
  return importRow(getDatabase().prepare(`SELECT i.*, d.retention, d.expires_at, d.session_id FROM nb_ai_imports i JOIN nb_documents d ON d.document_id = i.import_id WHERE i.notebook_id = ? AND i.file_hash = ? AND i.status = 'READY' LIMIT 1`).get(notebookId, fileHash));
}

// ── conversations / messages ────────────────────────────────────────────────
const convRow = (r) => r && ({
  conversationId: r.conversation_id, notebookId: r.notebook_id, importId: r.import_id, provider: r.provider, providerVerified: r.provider_verified === 1,
  externalId: r.external_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, sourceHash: r.source_hash, language: r.language,
  metadata: pj(r.metadata, {}), messageCount: r.message_count, contentHash: r.content_hash, currentNode: r.current_node,
});
export const getConversation = (id) => convRow(getDatabase().prepare('SELECT * FROM nb_ai_conversations WHERE conversation_id = ?').get(id));
export function getConversationsByIds(ids) {
  const out = new Map(); const db = getDatabase();
  for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); for (const r of db.prepare(`SELECT * FROM nb_ai_conversations WHERE conversation_id IN (${part.map(() => '?').join(',')})`).all(...part)) out.set(r.conversation_id, convRow(r)); }
  return out;
}
export function upsertConversation(c) {
  const db = getDatabase();
  const ex = db.prepare('SELECT * FROM nb_ai_conversations WHERE conversation_id = ?').get(c.conversationId);
  if (!ex) {
    db.prepare(`INSERT INTO nb_ai_conversations (conversation_id, notebook_id, import_id, provider, provider_verified, external_id, title, created_at, updated_at, source_hash, language, metadata, message_count, content_hash, current_node)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.conversationId, c.notebookId, c.importId, c.provider, c.providerVerified ? 1 : 0, c.externalId ?? null, c.title ?? '', c.createdAt ?? null, c.updatedAt ?? null, c.sourceHash ?? '', c.language ?? null, JSON.stringify(c.metadata ?? {}), c.messageCount ?? 0, c.contentHash ?? '', c.currentNode ?? null);
    return 'NEW';
  }
  const newer = c.updatedAt && (!ex.updated_at || c.updatedAt > ex.updated_at);
  db.prepare('UPDATE nb_ai_conversations SET message_count = message_count + ?, updated_at = ?, title = ?, content_hash = ?, current_node = COALESCE(?, current_node) WHERE conversation_id = ?')
    .run(c.messageCount ?? 0, newer ? c.updatedAt : ex.updated_at, c.title || ex.title, c.contentHash || ex.content_hash, c.currentNode ?? null, c.conversationId);
  return 'UPDATED';
}
export function getMessageKeyIndex(conversationId) {
  const m = new Map();
  for (const r of getDatabase().prepare('SELECT message_id, original_id, source_hash, is_current, role FROM nb_ai_messages WHERE conversation_id = ?').all(conversationId)) m.set(r.message_id, r);
  return m;
}
export function getCurrentByOriginalId(conversationId) {
  const m = new Map();
  for (const r of getDatabase().prepare('SELECT message_id, original_id, source_hash FROM nb_ai_messages WHERE conversation_id = ? AND original_id IS NOT NULL AND is_current = 1').all(conversationId)) m.set(r.original_id, r);
  return m;
}
const MSG_COLS = 'message_id, conversation_id, notebook_id, import_id, role, content, created_at, provider, original_id, parent_id, original_parent_id, content_type, trust_level, source_hash, ordinal, on_main_path, is_current, superseded_by, code_langs, flags';
export function insertMessages(rows) {
  const st = getDatabase().prepare(`INSERT OR IGNORE INTO nb_ai_messages (${MSG_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`);
  let n = 0;
  for (const r of rows) n += st.run(r.messageId, r.conversationId, r.notebookId, r.importId, r.role, r.content, r.createdAt ?? null, r.provider, r.originalId ?? null, r.parentId ?? null, r.originalParentId ?? null, r.contentType ?? 'text', r.trustLevel, r.sourceHash, r.ordinal, r.onMainPath === false ? 0 : 1, JSON.stringify(r.codeLangs ?? []), JSON.stringify(r.flags ?? [])).changes;
  return n;
}
export function supersedeMessage(oldId, newId) {
  const db = getDatabase();
  db.prepare('UPDATE nb_ai_messages SET is_current = 0, superseded_by = ? WHERE message_id = ?').run(newId, oldId);
  db.prepare(`UPDATE nb_chunks SET is_current = 0 WHERE ai_message_ids LIKE ?`).run(`%"${oldId}"%`);
}
const msgRow = (r) => r && ({
  messageId: r.message_id, conversationId: r.conversation_id, notebookId: r.notebook_id, importId: r.import_id, role: r.role, content: r.content, createdAt: r.created_at,
  provider: r.provider, originalId: r.original_id, parentId: r.parent_id, originalParentId: r.original_parent_id, contentType: r.content_type, trustLevel: r.trust_level,
  sourceHash: r.source_hash, ordinal: r.ordinal, onMainPath: r.on_main_path === 1, isCurrent: r.is_current === 1, supersededBy: r.superseded_by,
  codeLangs: pj(r.code_langs, []), flags: pj(r.flags, []),
});
export function getMessages(notebookId, ids) {
  const out = []; const db = getDatabase();
  for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); out.push(...db.prepare(`SELECT * FROM nb_ai_messages WHERE notebook_id = ? AND message_id IN (${part.map(() => '?').join(',')})`).all(notebookId, ...part).map(msgRow)); }
  return out;
}
export function getMessage(notebookId, id) { return msgRow(getDatabase().prepare('SELECT * FROM nb_ai_messages WHERE notebook_id = ? AND message_id = ?').get(notebookId, id)); }
export function listMessages(notebookId, conversationId, { limit = 100, offset = 0, currentOnly = false } = {}) {
  return getDatabase().prepare(`SELECT * FROM nb_ai_messages WHERE notebook_id = ? AND conversation_id = ? AND (? = 0 OR is_current = 1) ORDER BY ordinal LIMIT ? OFFSET ?`).all(notebookId, conversationId, currentOnly ? 1 : 0, limit, offset).map(msgRow);
}
export function countMessages(notebookId, conversationId) { return getDatabase().prepare('SELECT COUNT(*) n FROM nb_ai_messages WHERE notebook_id = ? AND conversation_id = ?').get(notebookId, conversationId).n; }
export function iterImportMessages(importId, { afterOrdinal = -1, limit = 2000 } = {}) { // for distillation, paged
  return getDatabase().prepare('SELECT * FROM nb_ai_messages WHERE import_id = ? AND is_current = 1 ORDER BY conversation_id, ordinal').all(importId).map(msgRow);
}
export function listConversationIdsOfImport(importId) {
  return getDatabase().prepare('SELECT DISTINCT conversation_id FROM nb_ai_messages WHERE import_id = ?').all(importId).map(r => r.conversation_id);
}
export function listConversations(notebookId, { importId = null, provider = null, q = null, from = null, to = null, limit = 50, offset = 0, sessionId = null, nowIso = now() } = {}) {
  let sql = `SELECT c.* FROM nb_ai_conversations c JOIN nb_documents d ON d.document_id = c.import_id WHERE c.notebook_id = ? AND ${VIS}`;
  const p = [notebookId, nowIso, sessionId];
  if (importId) { sql += ' AND c.import_id = ?'; p.push(importId); }
  if (provider) { sql += ' AND c.provider = ?'; p.push(provider); }
  if (q) { sql += ' AND c.title LIKE ?'; p.push(`%${String(q).replace(/[%_]/g, m => `\\${m}`)}%`); sql += " ESCAPE '\\'"; }
  if (from) { sql += ' AND c.created_at >= ?'; p.push(from); }
  if (to) { sql += ' AND c.created_at <= ?'; p.push(to); }
  sql += ' ORDER BY COALESCE(c.created_at, \'\') DESC, c.conversation_id LIMIT ? OFFSET ?'; p.push(limit, offset);
  return getDatabase().prepare(sql).all(...p).map(convRow);
}
export function countConversations(notebookId, { importId = null, sessionId = null, nowIso = now() } = {}) {
  let sql = `SELECT COUNT(*) n FROM nb_ai_conversations c JOIN nb_documents d ON d.document_id = c.import_id WHERE c.notebook_id = ? AND ${VIS}`; const p = [notebookId, nowIso, sessionId];
  if (importId) { sql += ' AND c.import_id = ?'; p.push(importId); }
  return getDatabase().prepare(sql).get(...p).n;
}
export function insertAttachments(rows) {
  const st = getDatabase().prepare('INSERT OR IGNORE INTO nb_ai_attachments (attachment_id, message_id, conversation_id, notebook_id, import_id, name, mime, size, status, reason, indexed) VALUES (?,?,?,?,?,?,?,?,?,?,0)');
  for (const a of rows) st.run(a.attachmentId, a.messageId, a.conversationId, a.notebookId, a.importId, String(a.name).slice(0, 200), a.mime ?? '', a.size ?? null, a.status, a.reason ?? null);
}
export function listAttachments(notebookId, messageIds) {
  const out = []; const db = getDatabase();
  for (let i = 0; i < messageIds.length; i += 500) { const part = messageIds.slice(i, i + 500); out.push(...db.prepare(`SELECT * FROM nb_ai_attachments WHERE notebook_id = ? AND message_id IN (${part.map(() => '?').join(',')})`).all(notebookId, ...part).map(r => ({ attachmentId: r.attachment_id, messageId: r.message_id, name: r.name, mime: r.mime, size: r.size, status: r.status, reason: r.reason, indexed: r.indexed === 1 }))); }
  return out;
}

// ── chunks (conversation segments) — reuses nb_chunks + nb_chunks_fts ──────
export function insertAiChunks({ notebookId, importId, conversationId, provider, title, trustByRole, chunks }) {
  const db = getDatabase(); const t = now();
  const ins = db.prepare(`INSERT INTO nb_chunks (chunk_id, notebook_id, document_id, version_id, version_no, ordinal, text, heading_path, page, start_offset, end_offset, hash, is_current, trust_level, injection_flags, created_at,
      ai_conversation_id, ai_provider, ai_role, ai_message_ids, ai_ts, ai_branch, ai_langs) VALUES (?,?,?,?,1,?,?,?,NULL,NULL,NULL,?,1,?,?,?,?,?,?,?,?,?,?)`);
  const fts = db.prepare('INSERT INTO nb_chunks_fts (text, title, heading, source_name, chunk_id, notebook_id, document_id, version_id) VALUES (?,?,?,?,?,?,?,?)');
  for (const c of chunks) {
    ins.run(c.chunkId, notebookId, importId, importId, c.ordinal, c.text, JSON.stringify([title]), c.hash, trustByRole[c.role] ?? 'UNKNOWN', JSON.stringify(c.injectionFlags ?? []), t,
      conversationId, provider, c.role, JSON.stringify(c.messageIds), c.ts, c.branch ? 1 : 0, JSON.stringify(c.langs ?? []));
    fts.run(c.text, title, c.role, provider, c.chunkId, notebookId, importId, importId);
  }
}

// ── candidates ──────────────────────────────────────────────────────────────
const candRow = (r) => r && ({
  candidateId: r.candidate_id, notebookId: r.notebook_id, type: r.type, statement: r.statement, normKey: r.norm_key, trustLevel: r.trust_level, assertionType: r.assertion_type,
  confidence: r.confidence, status: r.status, method: r.method, statedAt: r.stated_at, lastEvidenceAt: r.last_evidence_at, createdAt: r.created_at, updatedAt: r.updated_at,
  edited: r.edited === 1, orphaned: r.orphaned === 1, promotion: r.promotion,
});
export function findCandidatesByType(notebookId, types) {
  return getDatabase().prepare(`SELECT * FROM nb_ai_candidates WHERE notebook_id = ? AND type IN (${types.map(() => '?').join(',')})`).all(notebookId, ...types).map(candRow);
}
export function insertCandidate(c) {
  getDatabase().prepare(`INSERT INTO nb_ai_candidates (candidate_id, notebook_id, type, statement, norm_key, trust_level, assertion_type, confidence, status, method, stated_at, last_evidence_at, created_at, updated_at, edited, orphaned, promotion)
    VALUES (?,?,?,?,?,?,?,?,'CANDIDATE',?,?,?,?,?,0,0,'NONE')`).run(c.candidateId, c.notebookId, c.type, c.statement, c.normKey, c.trustLevel, c.assertionType, c.confidence, c.method, c.statedAt ?? null, c.lastEvidenceAt ?? null, now(), now());
}
export function updateCandidate(id, f) {
  const map = { statement: 'statement', status: 'status', trustLevel: 'trust_level', assertionType: 'assertion_type', confidence: 'confidence', statedAt: 'stated_at', lastEvidenceAt: 'last_evidence_at', normKey: 'norm_key', promotion: 'promotion' };
  const sets = []; const vals = [];
  for (const [k, c] of Object.entries(map)) if (k in f) { sets.push(`${c} = ?`); vals.push(f[k]); }
  if ('edited' in f) { sets.push('edited = ?'); vals.push(f.edited ? 1 : 0); }
  if (!sets.length) return; sets.push('updated_at = ?'); vals.push(now());
  getDatabase().prepare(`UPDATE nb_ai_candidates SET ${sets.join(', ')} WHERE candidate_id = ?`).run(...vals, id);
}
export function addEvidence(rows) {
  const st = getDatabase().prepare('INSERT OR IGNORE INTO nb_ai_candidate_evidence (candidate_id, message_id, conversation_id, import_id, role, quote, ts) VALUES (?,?,?,?,?,?,?)');
  let n = 0; for (const e of rows) n += st.run(e.candidateId, e.messageId, e.conversationId, e.importId, e.role, String(e.quote ?? '').slice(0, 300), e.ts ?? null).changes; return n;
}
export function listEvidence(candidateId) {
  return getDatabase().prepare('SELECT * FROM nb_ai_candidate_evidence WHERE candidate_id = ? ORDER BY ts').all(candidateId).map(r => ({ candidateId: r.candidate_id, messageId: r.message_id, conversationId: r.conversation_id, importId: r.import_id, role: r.role, quote: r.quote, ts: r.ts }));
}
export function getCandidate(notebookId, id) { return candRow(getDatabase().prepare('SELECT * FROM nb_ai_candidates WHERE notebook_id = ? AND candidate_id = ?').get(notebookId, id)); }
export function listCandidates(notebookId, { status = null, type = null, importId = null, limit = 50, offset = 0 } = {}) {
  let sql = `SELECT k.*, (SELECT COUNT(*) FROM nb_ai_candidate_evidence e WHERE e.candidate_id = k.candidate_id) AS evidence_count,
      (SELECT COUNT(DISTINCT e.conversation_id) FROM nb_ai_candidate_evidence e WHERE e.candidate_id = k.candidate_id) AS conversation_count
    FROM nb_ai_candidates k WHERE k.notebook_id = ?`; const p = [notebookId];
  if (status) { sql += ' AND k.status = ?'; p.push(status); }
  if (type) { sql += ' AND k.type = ?'; p.push(type); }
  if (importId) { sql += ' AND EXISTS (SELECT 1 FROM nb_ai_candidate_evidence e WHERE e.candidate_id = k.candidate_id AND e.import_id = ?)'; p.push(importId); }
  sql += ' ORDER BY k.status = \'CANDIDATE\' DESC, k.confidence DESC, k.candidate_id LIMIT ? OFFSET ?'; p.push(limit, offset);
  return getDatabase().prepare(sql).all(...p).map(r => ({ ...candRow(r), evidenceCount: r.evidence_count, conversationCount: r.conversation_count }));
}
export function countCandidates(notebookId, status = null) {
  return status ? getDatabase().prepare('SELECT COUNT(*) n FROM nb_ai_candidates WHERE notebook_id = ? AND status = ?').get(notebookId, status).n : getDatabase().prepare('SELECT COUNT(*) n FROM nb_ai_candidates WHERE notebook_id = ?').get(notebookId).n;
}
export function addLink(l) { getDatabase().prepare('INSERT OR IGNORE INTO nb_ai_candidate_links (candidate_id, related_id, kind, ambiguous, detail) VALUES (?,?,?,?,?)').run(l.candidateId, l.relatedId, l.kind, l.ambiguous ? 1 : 0, l.detail ?? ''); }
export function listLinks(candidateId) {
  return getDatabase().prepare('SELECT * FROM nb_ai_candidate_links WHERE candidate_id = ? OR related_id = ?').all(candidateId, candidateId).map(r => ({ candidateId: r.candidate_id, relatedId: r.related_id, kind: r.kind, ambiguous: r.ambiguous === 1, detail: r.detail }));
}

export function listImportConversationMessages(importId, conversationId) {
  return getDatabase().prepare('SELECT * FROM nb_ai_messages WHERE import_id = ? AND conversation_id = ? AND is_current = 1 ORDER BY ordinal').all(importId, conversationId).map(msgRow);
}

// Rollback of an unfinished / cancelled / rejected import: removes ALL its data (rows, chunks, FTS,
// embedding metadata, candidate evidence) but keeps the import shell row (status CANCELLED / FAILED …).
// Returns the chunk ids so the caller can delete the vectors.
export function rollbackImportData(importId) {
  const db = getDatabase(); let chunkIds = [];
  db.transaction(() => {
    chunkIds = db.prepare('SELECT chunk_id FROM nb_chunks WHERE document_id = ?').all(importId).map(r => r.chunk_id);
    db.prepare('DELETE FROM nb_chunks_fts WHERE document_id = ?').run(importId);
    for (let i = 0; i < chunkIds.length; i += 500) { const part = chunkIds.slice(i, i + 500); db.prepare(`DELETE FROM nb_chunk_embeddings WHERE chunk_id IN (${part.map(() => '?').join(',')})`).run(...part); }
    db.prepare('DELETE FROM nb_chunks WHERE document_id = ?').run(importId);
    purgeAiImportRows(db, importId, { keepImportRow: true });
  })();
  return { chunkIds };
}

export function commitBatch(fn) { return getDatabase().transaction(fn)(); }
