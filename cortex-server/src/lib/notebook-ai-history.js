// Notebook NB-4 — AI-history import, search, questions and memory-candidate review.
//
// Built on the NB-3 document service (same SQLite/FTS5/LanceDB/Ollama machinery, same retention,
// same purge). Principles enforced here:
//  • an imported history is UNTRUSTED DATA and never a reliable memory: roles are preserved, trust
//    follows the role (USER→USER_AUTHORED, assistant→PAST_AI_OUTPUT, tool→TOOL_RESULT, else UNKNOWN);
//    nothing is ever promoted to verified fact / primary source / global memory;
//  • the raw archive is NEVER stored: only normalised rows + hashes + provenance;
//  • strictly local: no network, no cloud provider, no child_process, no executor import;
//  • an import is READY only when fully indexed; cancel / failure / rejection roll everything back.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NotebookImportError, safeFilename, guessLanguage } from './notebook-parsers.js';
import { scanSecrets, redactDocumentSecrets, detectInjection, buildCitationPack, buildDocumentMessages, AI_HISTORY_SYSTEM_PROMPT, assertionTypeFor } from './notebook-security.js';
import { addNotebookSource } from './sqlite.js';
import { recomputeAndPersistNotebookPrivacy } from './notebook.js';
import { applyContextBudget, confidenceLevel } from './notebook-retrieval.js';
import { detectConflicts } from './notebook-conflicts.js';
import { RETENTION_POLICIES, parseRetentionDuration } from './notebook-retention.js';
import { openZip, bufferReader, fileReader, looksLikeZip, bufferChunks, fileChunks, ZipSecurityError, resolveZipLimits } from './notebook-ai-zip.js';
import {
  detectAdapter, ADAPTER_BY_ID, ADAPTERS, validateConversation, resolveAttachment, trustForRole, sha, PROVIDERS, ROLES, PROVIDER_LABEL, codeLangs, toIso,
} from './notebook-ai-adapters.js';
import { segmentConversation } from './notebook-ai-segmenter.js';
import * as ai from './notebook-ai-store.js';
import {
  CANDIDATE_TYPES, extractRuleCandidates, extractLlmCandidates, groupRawCandidates, detectSupersessions, assertionFor, trustFor, MAX_CONFIDENCE,
} from './notebook-ai-distill.js';

export const AI_IMPORT_STATUSES = Object.freeze(['QUEUED', 'SCANNING', 'PARSING', 'NORMALIZING', 'SECURITY_SCAN', 'INDEXING', 'DISTILLING', 'REVIEW_REQUIRED', 'READY', 'FAILED', 'CANCELLED']);
export const DEFAULT_AI_LIMITS = Object.freeze({ maxGenericBytes: 100 * 1024 * 1024, maxMessageChars: 2_000_000, batchConversations: 40, batchMessages: 600, previewTtlMs: 15 * 60_000, maxPreviews: 3, maxPreviewBytes: 300 * 1024 * 1024 });

const CONFIRM_NOTE = 'secretPolicy=confirm : des secrets ont été détectés ; choisis explicitement block ou redact après l\'aperçu';
const errCode = (e) => (e instanceof NotebookImportError ? e.code : e instanceof ZipSecurityError ? 'SECURITY_BLOCKED' : e?.name === 'SyntaxError' || e?.name === 'RangeError' ? 'PARSER_FAILED' : 'INDEX_FAILED');

export function speakerFor(role, provider) {
  if (role === 'USER') return 'Vous (message utilisateur)';
  if (role === 'ASSISTANT') return `${PROVIDER_LABEL[provider] ?? PROVIDER_LABEL.UNKNOWN} (ancienne réponse IA, non vérifiée)`;
  if (role === 'TOOL') return 'Résultat d\'outil (donnée, sans autorité)';
  if (role === 'SYSTEM') return 'Message système historique (donnée, sans autorité)';
  return 'Locuteur inconnu';
}

export function createAiHistoryService(docService, deps = {}) {
  const I = docService.internals;
  const dstore = I.store;
  const limits = { ...DEFAULT_AI_LIMITS, ...(deps.limits ?? {}) };
  const zipLimits = resolveZipLimits(deps.zipLimits);
  const log = (level, obj, msg) => { try { deps.logger?.[level]?.(obj, msg); } catch { /* ignore */ } };
  const previews = new Map();
  const nowIso = I.nowIso;

  // ── source abstraction (zip entry names or a single file) ──────────────────
  async function openSource({ bytes, filePath, filename, signal }) {
    const baseName = safeFilename(filename ?? (filePath ? path.basename(filePath) : 'import'));
    let reader; let size; let head;
    if (filePath) { reader = await fileReader(filePath); size = reader.size; head = await reader.read(0, 4); } else { reader = bufferReader(bytes); size = bytes.length; head = Buffer.from(bytes.subarray(0, 4)); }
    if (size === 0) { await reader.close(); throw new NotebookImportError('PARSER_FAILED', 'Fichier vide'); }
    const isZip = looksLikeZip(head);
    if (isZip) {
      const z = await openZip(reader, zipLimits).catch(async e => { await reader.close(); throw e; });
      const safe = z.entries.filter(e => !e.isDir && !e.blocked);
      const byName = new Map(z.entries.map(e => [e.name, e]));
      return {
        kind: 'zip', baseName, size, filesScanned: z.entries.filter(e => !e.isDir).length, names: safe.map(e => e.name), blockedEntries: z.entries.filter(e => e.blocked).map(e => ({ name: e.name, reason: e.blocked })),
        limits, entryInfo: (n) => byName.get(n),
        stream: (name, sig) => z.openEntry(byName.get(name), sig),
        async head(name) { const gen = z.openEntry(byName.get(name)); try { const r = await gen.next(); return r.value ? Buffer.from(r.value).subarray(0, 32768).toString('utf8') : ''; } finally { await gen.return?.(); } },
        async readText(name, max) { const parts = []; let n = 0; for await (const c of z.openEntry(byName.get(name), signal)) { n += c.length; if (n > max) throw new NotebookImportError('FILE_TOO_LARGE', 'Fichier texte trop volumineux'); parts.push(c); } return Buffer.concat(parts).toString('utf8'); },
        close: () => z.close(),
      };
    }
    const name = baseName;
    if (!/\.(json|html?|md|markdown|txt)$/i.test(name)) { await reader.close(); throw new NotebookImportError('UNSUPPORTED_FORMAT', 'Formats acceptés : archive .zip, .json, .html, .md, .txt'); }
    return {
      kind: 'file', baseName: name.replace(/\.[^.]+$/, ''), size, filesScanned: 1, names: [name], blockedEntries: [], limits, entryInfo: () => null,
      stream: (n, sig) => (filePath ? fileChunks(filePath, sig) : bufferChunks(bytes)),
      async head() { const b = await reader.read(0, 32768); return b.toString('utf8'); },
      async readText(n, max) { if (size > max) throw new NotebookImportError('FILE_TOO_LARGE', 'Fichier trop volumineux'); return (await reader.read(0, size)).toString('utf8'); },
      close: () => reader.close(),
    };
  }

  async function hashInput({ bytes, filePath }) {
    const h = crypto.createHash('sha256');
    if (bytes) return h.update(bytes).digest('hex');
    for await (const c of fs.createReadStream(filePath)) h.update(c);
    return h.digest('hex');
  }

  const newCounts = () => ({ files: 0, conversations: 0, conversationsNew: 0, conversationsUpdated: 0, conversationsUnchanged: 0, invalid: 0, messages: 0, messagesNew: 0, messagesDuplicate: 0, messagesBlocked: 0, messagesRedacted: 0, attachments: 0, attachmentsAvailable: 0, attachmentsMissing: 0, attachmentsUnsupported: 0, attachmentsBlocked: 0, chunks: 0, vectorFailed: false, blockedEntries: 0 });

  // ── the streaming pipeline (mode: 'preview' = no persistence, 'import') ────
  async function runPipeline({ mode, notebookId, importId, source, forceAdapter, declaredProvider, secretPolicy, signal, embed = true, onStatus, onProgress }) {
    onStatus?.('SCANNING');
    const det = await detectAdapter(source, { forceAdapter });
    if (!det) throw new NotebookImportError('UNSUPPORTED_FORMAT', 'Structure d\'export non reconnue (aucun adaptateur ne correspond)');
    const adapter = det.adapter;
    const provider = adapter.provider; // provider is attributed ONLY from a recognised structure
    const providerVerified = !!det.providerVerified;
    const counts = newCounts(); counts.files = source.filesScanned; counts.blockedEntries = source.blockedEntries.length;
    if (declaredProvider) counts.declaredProvider = declaredProvider;
    const findings = new Map(); const titles = []; let minDate = null; let maxDate = null;
    let batch = { convs: [], messages: [], supersede: [], attachments: [], chunks: [], touched: new Set() };
    let chunkSeq = 0; let needsConfirm = false; let lastProgress = 0;
    const doc = mode === 'import' ? dstore.getDocument(importId) : null;

    const noteFinding = (f) => { for (const x of f) { const k = findings.get(x.kind) ?? { kind: x.kind, severity: x.severity, count: 0 }; k.count += x.count; findings.set(x.kind, k); } };

    async function commit() {
      if (!batch.convs.length && !batch.messages.length && !batch.chunks.length) return;
      signal?.throwIfAborted?.();
      onStatus?.('INDEXING');
      let vectors = null;
      if (embed && batch.chunks.length) {
        try { vectors = await I.embedChunks(batch.chunks.map(c => ({ text: c.text })), signal); } catch (e) { if (signal?.aborted) throw e; counts.vectorFailed = true; }
      }
      signal?.throwIfAborted?.();
      if (!dstore.getDocument(importId)) throw Object.assign(new Error('import supprimé'), { code: 'SOURCE_DELETED' });
      // one synchronous transaction: rows + chunks + FTS (no interleaving with a delete)
      ai.commitBatch(() => {
        for (const c of batch.convs) ai.upsertConversation(c);
        ai.insertMessages(batch.messages);
        for (const [o, n] of batch.supersede) ai.supersedeMessage(o, n);
        ai.insertAttachments(batch.attachments);
        for (const g of batch.chunkGroups ?? []) ai.insertAiChunks(g);
      });
      const chunks = batch.chunks;
      if (vectors && chunks.length) {
        try { await I.storeVectors({ notebookId, documentId: importId }, { versionId: importId }, chunks, vectors); } catch (e) { if (e?.code === 'SOURCE_DELETED' || signal?.aborted) throw e; counts.vectorFailed = true; }
      }
      counts.chunks += chunks.length;
      I.invalidateCounts(notebookId);
      batch = { convs: [], messages: [], supersede: [], attachments: [], chunks: [], touched: new Set(), chunkGroups: [] };
      ai.updateImport(importId, { counts });
    }

    let first = true;
    for await (const item of adapter.conversations(source, { signal })) {
      signal?.throwIfAborted?.();
      if (first) { onStatus?.('PARSING'); onStatus?.('NORMALIZING'); onStatus?.('SECURITY_SCAN'); first = false; }
      counts.conversations++;
      let conv;
      try { conv = adapter.normalize(item.raw, { entry: item.entry }); } catch { counts.invalid++; continue; }
      const v = validateConversation(conv, { maxMessageChars: limits.maxMessageChars });
      if (!v.ok || conv.messages.length === 0) { counts.invalid++; continue; }
      if (titles.length < 5 && conv.title) titles.push(String(conv.title).slice(0, 80));

      // secret scan (message level) — BLOCK drops the message, REDACT masks it, CONFIRM stops the import
      const msgs = [];
      for (const m of conv.messages) {
        counts.messages++;
        const scan = scanSecrets(m.content);
        let content = m.content; let flags = [];
        if (scan.hasSecrets) {
          noteFinding(scan.findings);
          if (mode === 'import' && secretPolicy === 'confirm') { needsConfirm = true; continue; }
          if (scan.mustBlock || secretPolicy === 'block' || secretPolicy === 'confirm') { counts.messagesBlocked++; continue; }
          content = redactDocumentSecrets(content); flags = ['redacted']; counts.messagesRedacted++;
        }
        const t = m.createdAt; if (t) { if (!minDate || t < minDate) minDate = t; if (!maxDate || t > maxDate) maxDate = t; }
        msgs.push({ ...m, content, flags });
      }
      if (needsConfirm) break;
      for (const m of msgs) for (const a of m.attachments ?? []) { counts.attachments++; const r = resolveAttachment(a, source); counts[`attachments${{ AVAILABLE: 'Available', MISSING: 'Missing', UNSUPPORTED: 'Unsupported', SECURITY_BLOCKED: 'Blocked' }[r.status]}`]++; }
      if (mode === 'preview' || msgs.length === 0) { if (msgs.length === 0) counts.conversationsUnchanged++; else counts.messagesNew += msgs.length; continue; }

      // ── import: ids, dedup, incremental update ────────────────────────────
      let title = conv.title ?? '';
      const titleScan = scanSecrets(title); if (titleScan.hasSecrets) { noteFinding(titleScan.findings); title = redactDocumentSecrets(title); }
      const first0 = msgs[0]?.content ?? '';
      const convKey = conv.externalId ?? `gen:${sha(`${title}|${first0}`).slice(0, 24)}`;
      const conversationId = `naic-${sha(`${notebookId}|${provider}|${convKey}`).slice(0, 32)}`;
      const existing = ai.getConversation(conversationId);
      const known = existing ? ai.getMessageKeyIndex(conversationId) : new Map();
      const byOid = existing ? ai.getCurrentByOriginalId(conversationId) : new Map();
      const occ = new Map(); const idByOriginal = new Map(); const seenIds = new Set(); const newMsgs = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]; const hash = sha(`${m.role}\0${m.content}`);
        let messageId; let supersedes = null;
        if (m.originalId) {
          messageId = `naim-${sha(`${conversationId}|oid:${m.originalId}|${hash}`).slice(0, 32)}`;
          const cur = byOid.get(m.originalId); if (cur && cur.message_id !== messageId) supersedes = cur.message_id;
          if (!idByOriginal.has(m.originalId)) idByOriginal.set(m.originalId, messageId);
        } else {
          const k = `${m.role}|${hash}`; const n = (occ.get(k) ?? 0) + 1; occ.set(k, n);
          messageId = `naim-${sha(`${conversationId}|h:${k}|${n}`).slice(0, 32)}`;
        }
        if (known.has(messageId) || seenIds.has(messageId)) { counts.messagesDuplicate++; continue; }
        seenIds.add(messageId);
        newMsgs.push({ m, hash, messageId, supersedes, ordinal: i });
      }
      const rows = newMsgs.map(({ m, hash, messageId, ordinal }) => ({
        messageId, conversationId, notebookId, importId, role: m.role, content: m.content, createdAt: m.createdAt, provider, originalId: m.originalId,
        originalParentId: m.parentOriginalId, parentId: m.parentOriginalId ? (idByOriginal.get(m.parentOriginalId) ?? byOid.get(m.parentOriginalId)?.message_id ?? null) : null,
        contentType: m.contentType, trustLevel: trustForRole(m.role), sourceHash: hash, ordinal, onMainPath: m.onMainPath, codeLangs: codeLangs(m.content), flags: m.flags,
      }));
      counts.messagesNew += rows.length;
      if (!rows.length) { counts.conversationsUnchanged++; continue; }
      if (existing) counts.conversationsUpdated++; else counts.conversationsNew++;
      const contentHash = sha(newMsgs.map(x => x.hash).join('|'));
      batch.convs.push({ conversationId, notebookId, importId, provider, providerVerified, externalId: conv.externalId, title, createdAt: conv.createdAt ?? rows[0]?.createdAt ?? null, updatedAt: conv.updatedAt ?? rows.at(-1)?.createdAt ?? null, sourceHash: sha(convKey), language: guessLanguage(rows.map(r => r.content).join('\n').slice(0, 4000)), metadata: { entry: conv.entry, externalIdSynthetic: !!conv.externalIdSynthetic, ...(conv.metadata ?? {}) }, messageCount: rows.length, contentHash, currentNode: conv.currentNode });
      batch.messages.push(...rows);
      for (const nm of newMsgs) if (nm.supersedes) batch.supersede.push([nm.supersedes, nm.messageId]);
      batch.touched.add(conversationId);
      for (const r of rows) {
        const src = newMsgs.find(x => x.messageId === r.messageId).m;
        for (const [k, a] of (src.attachments ?? []).entries()) { const res = resolveAttachment(a, source); batch.attachments.push({ attachmentId: `naia-${sha(`${r.messageId}|${k}|${a.name}|${a.ref}`).slice(0, 32)}`, messageId: r.messageId, conversationId, notebookId, importId, name: a.name || a.ref || '(sans nom)', mime: a.mime, size: a.size, status: res.status, reason: res.reason }); }
      }
      const segs = segmentConversation(title, rows.map(r => ({ messageId: r.messageId, role: r.role, content: r.content, createdAt: r.createdAt, onMainPath: r.onMainPath })));
      const chunkList = segs.map((s, i) => {
        const inj = detectInjection(s.text).kinds; if (s.role === 'SYSTEM') inj.push('HISTORICAL_SYSTEM_MESSAGE'); if (s.role === 'TOOL') inj.push('TOOL_OUTPUT');
        return { ...s, chunkId: `${importId}:${++chunkSeq}`, ordinal: chunkSeq, injectionFlags: [...new Set(inj)] };
      });
      batch.chunks.push(...chunkList);
      (batch.chunkGroups ??= []).push({ notebookId, importId, conversationId, provider, title: title || '(sans titre)', trustByRole: { USER: 'USER_AUTHORED', ASSISTANT: 'PAST_AI_OUTPUT', TOOL: 'TOOL_RESULT', SYSTEM: 'UNKNOWN', UNKNOWN: 'UNKNOWN' }, chunks: chunkList });
      if (batch.convs.length >= limits.batchConversations || batch.messages.length >= limits.batchMessages) await commit();
      if (Date.now() - lastProgress > 300) { lastProgress = Date.now(); ai.updateImport(importId, { counts }); onProgress?.(counts); }
    }
    if (mode === 'import' && !needsConfirm) await commit();
    return {
      adapter: adapter.id, provider, providerVerified, detection: det.reason, counts, needsConfirm, findings: [...findings.values()],
      dateRange: { from: minDate, to: maxDate }, titles, blockedEntries: source.blockedEntries, syntheticCoverage: adapter.provider !== 'UNKNOWN',
    };
  }

  // ── validation shared by preview / import ─────────────────────────────────
  function checkOptions(o) {
    const retention = o.retention ?? 'KEEP';
    if (!RETENTION_POLICIES.includes(retention)) throw new NotebookImportError('INVALID_OPTION', `Rétention inconnue : ${retention}`);
    let expiresAt = null;
    if (retention === 'DELETE_AFTER') { const ms = parseRetentionDuration(o.retentionDuration); if (ms == null) throw new NotebookImportError('INVALID_OPTION', 'DELETE_AFTER exige une durée valide (1h, 24h, 7d)'); expiresAt = new Date(I.clock() + ms).toISOString(); }
    else if (o.retentionDuration) throw new NotebookImportError('INVALID_OPTION', 'Une durée n\'est acceptée qu\'avec DELETE_AFTER');
    const secretPolicy = o.secretPolicy ?? 'block';
    if (!['block', 'redact', 'confirm'].includes(secretPolicy)) throw new NotebookImportError('INVALID_OPTION', 'secretPolicy invalide');
    if (o.adapter && !ADAPTER_BY_ID[o.adapter]) throw new NotebookImportError('INVALID_OPTION', `adapter inconnu : ${o.adapter}`);
    if (o.declaredProvider && !PROVIDERS.includes(o.declaredProvider)) throw new NotebookImportError('INVALID_OPTION', 'provider déclaré invalide');
    return { retention, expiresAt, secretPolicy };
  }

  // ── preview (dry run: nothing is stored except an in-memory copy of the upload) ─
  async function preview(o) {
    const { notebookId } = o; checkOptions(o);
    const bytes = o.bytes; const filePath = o.path;
    if (!bytes && !filePath) throw new NotebookImportError('INVALID_OPTION', 'Fichier requis');
    const fileSize = bytes ? bytes.length : fs.statSync(filePath).size;
    if (fileSize > zipLimits.maxArchiveBytes) throw new NotebookImportError('FILE_TOO_LARGE', 'Archive trop volumineuse');
    const source = await openSource({ bytes, filePath, filename: o.filename });
    try {
      const r = await runPipeline({ mode: 'preview', notebookId, source, forceAdapter: o.adapter, declaredProvider: o.declaredProvider, secretPolicy: o.secretPolicy ?? 'block', embed: false });
      let previewId = null;
      if (bytes) { // keep the upload in memory only (bounded, TTL) so that confirming does not require a second upload
        const total = [...previews.values()].reduce((n, p) => n + p.bytes.length, 0);
        if (previews.size >= limits.maxPreviews || total + bytes.length > limits.maxPreviewBytes) { const oldest = [...previews.keys()][0]; previews.delete(oldest); }
        previewId = `nprev-${crypto.randomUUID()}`;
        const timer = setTimeout(() => previews.delete(previewId), limits.previewTtlMs); timer.unref?.();
        previews.set(previewId, { notebookId, bytes, filename: o.filename, timer });
      }
      log('info', { stage: 'AI_IMPORT_PREVIEW', conversations: r.counts.conversations, messages: r.counts.messages, adapter: r.adapter }, 'NOTEBOOK_AI_PREVIEW');
      return { previewId, size: fileSize, ...r, fileHash: await hashInput({ bytes, filePath }) };
    } finally { await source.close(); }
  }

  // ── import ────────────────────────────────────────────────────────────────
  function startImport(o) {
    const { notebookId } = o;
    const { retention, expiresAt, secretPolicy } = checkOptions(o);
    let bytes = o.bytes; let filename = o.filename;
    if (o.previewId) {
      const p = previews.get(o.previewId);
      if (!p || p.notebookId !== notebookId) throw new NotebookImportError('INVALID_OPTION', 'Aperçu expiré ou inconnu : recommence l\'aperçu');
      bytes = p.bytes; filename = p.filename; clearTimeout(p.timer); previews.delete(o.previewId);
    }
    const filePath = o.path;
    if (!bytes && !filePath) throw new NotebookImportError('INVALID_OPTION', 'Fichier requis');
    const size = bytes ? bytes.length : fs.statSync(filePath).size;
    if (size > zipLimits.maxArchiveBytes) throw new NotebookImportError('FILE_TOO_LARGE', `Archive trop volumineuse (${size} > ${zipLimits.maxArchiveBytes})`);
    const name = safeFilename(filename ?? (filePath ? path.basename(filePath) : 'import'));

    const fileHashP = hashInput({ bytes, filePath });
    const importId = ai.newImportId();
    const ctrl = new AbortController(); I.aborts.set(importId, ctrl);
    const sessionId = I.sessionId;

    const run = async () => {
      const fileHash = await fileHashP;
      const dup = ai.findImportByHash(notebookId, fileHash);
      if (dup && (!dup.expiresAt || dup.expiresAt > nowIso())) { I.aborts.delete(importId); return { importId: dup.importId, duplicate: true, status: 'READY' }; }
      // rows: document (retention / visibility), notebook source, import shell
      const rowId = crypto.randomUUID();
      addNotebookSource({ id: rowId, notebookId, sourceType: 'ai_history', sourceId: importId, title: `Historique IA · ${name}`, provenance: 'import:ai_history', privacy: true, egressPolicy: 'local_only' });
      dstore.insertDocument({ documentId: importId, notebookId, sourceRowId: rowId, nameKey: `ai-history:${importId}`, title: `Historique IA · ${name}`, mimeType: 'application/x-ai-history', hash: fileHash, size, status: 'QUEUED', trustLevel: 'UNKNOWN', retention, origin: 'ai_history', expiresAt, sessionId: retention === 'SESSION_ONLY' ? sessionId : null });
      recomputeAndPersistNotebookPrivacy(notebookId);
      ai.insertImport({ importId, notebookId, sourceName: name, fileHash, size, status: 'QUEUED', secretPolicy });
      return { importId, duplicate: false, fileHash, name, rowId };
    };

    const setStatus = (s) => { dstore.updateDocument(importId, { status: s }); ai.updateImport(importId, { status: s }); };
    const done = (async () => {
      let ctx;
      try { ctx = await run(); } catch (e) { I.aborts.delete(importId); return { importId, status: 'FAILED', errorCode: errCode(e), message: e.message }; }
      if (ctx.duplicate) return ctx;
      return I.limiter.run(async () => {
        const t0 = Date.now(); let source;
        try {
          ctrl.signal.throwIfAborted();
          setStatus('SCANNING');
          source = await openSource({ bytes, filePath, filename: name, signal: ctrl.signal });
          const r = await runPipeline({ mode: 'import', notebookId, importId, source, forceAdapter: o.adapter, declaredProvider: o.declaredProvider, secretPolicy, signal: ctrl.signal, embed: o.vectors !== false, onStatus: setStatus });
          if (r.needsConfirm) { await rollback(importId, notebookId); ai.updateImport(importId, { status: 'REVIEW_REQUIRED', errorCode: 'SECRET_DETECTED', findings: r.findings, provider: r.provider, adapter: r.adapter, counts: r.counts }); dstore.updateDocument(importId, { status: 'REVIEW_REQUIRED', errorCode: 'SECRET_DETECTED' }); return { importId, status: 'REVIEW_REQUIRED', errorCode: 'SECRET_DETECTED', findings: r.findings, message: CONFIRM_NOTE, requiresConfirmation: true }; }
          if (r.counts.conversations === 0 || (r.counts.conversations === r.counts.invalid)) throw new NotebookImportError('PARSER_FAILED', 'Aucune conversation exploitable dans cet export');
          ctrl.signal.throwIfAborted();
          if (!dstore.getDocument(importId)) throw Object.assign(new Error('supprimé'), { code: 'SOURCE_DELETED' });
          ai.updateImport(importId, { provider: r.provider, adapter: r.adapter, providerVerified: r.providerVerified, counts: r.counts, findings: r.findings, status: 'READY' });
          dstore.updateDocument(importId, { status: 'READY', errorCode: null });
          log('info', { importId, stage: 'READY', conversations: r.counts.conversations, messages: r.counts.messagesNew, chunks: r.counts.chunks, durationMs: Date.now() - t0 }, 'NOTEBOOK_AI_IMPORT_END');
          const out = { importId, status: 'READY', provider: r.provider, providerVerified: r.providerVerified, counts: r.counts, findings: r.findings };
          if (o.distill) out.distill = await distill(notebookId, importId, { useLlm: o.distillLlm === true, signal: ctrl.signal }).catch(e => ({ ok: false, error: errCode(e) }));
          return out;
        } catch (e) {
          if (ctrl.signal.aborted || e?.code === 'SOURCE_DELETED' || e?.name === 'AbortError') {
            if (!dstore.getDocument(importId)) return { importId, status: 'CANCELLED', errorCode: 'SOURCE_DELETED' }; // deleted while running: already purged
            await rollback(importId, notebookId); ai.updateImport(importId, { status: 'CANCELLED' }); dstore.updateDocument(importId, { status: 'CANCELLED' });
            return { importId, status: 'CANCELLED' };
          }
          await rollback(importId, notebookId).catch(() => {});
          const code = errCode(e);
          ai.updateImport(importId, { status: 'FAILED', errorCode: code }); dstore.updateDocument(importId, { status: 'FAILED', errorCode: code });
          log('warn', { importId, stage: 'FAILED', code }, 'NOTEBOOK_AI_IMPORT_FAILED');
          return { importId, status: 'FAILED', errorCode: code, message: e?.message };
        } finally { try { await source?.close(); } catch { /* ignore */ } I.aborts.delete(importId); }
      }).catch(async e => { await rollback(importId, notebookId).catch(() => {}); return { importId, status: 'FAILED', errorCode: e?.code ?? 'INDEX_FAILED' }; });
    })();
    return { importId, done };
  }

  async function importHistory(o) { const h = startImport(o); const r = await h.done; return { importId: h.importId, ...r }; }

  // Removes every trace of an unfinished import except its status shell.
  async function rollback(importId, notebookId) {
    const { chunkIds } = ai.rollbackImportData(importId);
    I.invalidateCounts(notebookId);
    await I.purgeVectors(chunkIds, { notebookId, sourceId: importId });
  }

  function cancelImport(notebookId, importId) {
    const imp = ai.getImport(importId);
    if (!imp || imp.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    const c = I.aborts.get(importId); if (!c) return { ok: false, error: 'NOT_RUNNING' };
    c.abort(); return { ok: true };
  }

  async function deleteImport(notebookId, importId) {
    const imp = ai.getImport(importId);
    if (!imp || imp.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    return docService.removeDocument(notebookId, importId); // aborts a running import, purges rows / FTS / embeddings / vectors / candidate evidence
  }

  // ── distillation → memory CANDIDATES (Notebook-scoped; never global memory) ─
  async function distill(notebookId, importId, { useLlm = false, signal } = {}) {
    const imp = ai.getImport(importId);
    if (!imp || imp.notebookId !== notebookId) throw new NotebookImportError('SOURCE_DELETED', 'Import introuvable');
    if (imp.status !== 'READY') throw new NotebookImportError('INVALID_OPTION', 'L\'import doit être READY');
    ai.updateImport(importId, { distillStatus: 'DISTILLING' });
    const llm = { requested: useLlm, status: useLlm ? 'PENDING' : 'NOT_REQUESTED' };
    let llmOk = false;
    if (useLlm) {
      const available = deps.localModelAvailable ? await deps.localModelAvailable().catch(() => false) : false;
      if (!available || !deps.localComplete) llm.status = 'LOCAL_MODEL_UNAVAILABLE'; // never downloads / installs a model
      else llmOk = true;
    }
    const raw = []; const llmStats = { batches: 0, accepted: 0, proposed: 0 }; let llmBudget = 200;
    try {
      for (const convId of ai.listConversationIdsOfImport(importId)) {
        signal?.throwIfAborted?.();
        const msgs = ai.listImportConversationMessages(importId, convId);
        raw.push(...extractRuleCandidates(msgs));
        if (llmOk && llmBudget > 0) {
          const r = await extractLlmCandidates(msgs, deps.localComplete, { maxMessages: llmBudget, signal });
          raw.push(...r.candidates); llmBudget -= Math.min(msgs.length, llmBudget); llmStats.batches += r.stats.batches; llmStats.accepted += r.stats.accepted; llmStats.proposed += r.stats.proposed;
        }
      }
      if (llmOk) llm.status = 'USED';
      const existing = ai.findCandidatesByType(notebookId, CANDIDATE_TYPES).map(c => ({ candidateId: c.candidateId, type: c.type, statement: c.statement, normKey: c.normKey }));
      const groups = groupRawCandidates(raw, existing);
      let created = 0; let extended = 0; const newIds = [];
      ai.commitBatch(() => {
        for (const g of groups) {
          const roles = new Set(g.evidence.map(e => e.role)); const ts = g.evidence.map(e => e.ts).filter(Boolean).sort();
          let id = g.existingId;
          if (id) {
            const before = ai.listEvidence(id).length;
            ai.addEvidence(g.evidence.map(e => ({ candidateId: id, messageId: e.messageId, conversationId: e.conversationId, importId: e.importId, role: e.role, quote: g.statement, ts: e.ts })));
            const after = ai.listEvidence(id).length; if (after > before) extended++;
            ai.updateCandidate(id, { lastEvidenceAt: ts.at(-1) ?? null });
          } else {
            id = ai.newCandidateId();
            const base = Math.max(...g.evidence.map(e => e.confidence)); let cap = roles.has('USER') ? MAX_CONFIDENCE : Math.min(MAX_CONFIDENCE, 0.5);
            if (g.evidence.every(e => e.method === 'llm')) cap = Math.min(cap, 0.6); // LLM-only candidates never exceed 0.6
            const conf = Math.min(cap, base + 0.05 * (g.evidence.length - 1));
            ai.insertCandidate({ candidateId: id, notebookId, type: g.type, statement: g.statement, normKey: g.normKey, trustLevel: trustFor(roles), assertionType: assertionFor(g.type, roles), confidence: Number(conf.toFixed(2)), method: g.evidence.some(e => e.method === 'llm') ? 'llm' : 'rule', statedAt: ts[0] ?? null, lastEvidenceAt: ts.at(-1) ?? null });
            ai.addEvidence(g.evidence.map(e => ({ candidateId: id, messageId: e.messageId, conversationId: e.conversationId, importId: e.importId, role: e.role, quote: g.statement, ts: e.ts })));
            created++; newIds.push(id);
          }
        }
      });
      // possible supersessions (never an automatic status change)
      const topical = ai.findCandidatesByType(notebookId, ['DECISION', 'REQUIREMENT', 'PREFERENCE']).filter(c => c.status !== 'REJECTED');
      const links = detectSupersessions(topical.map(c => ({ candidateId: c.candidateId, type: c.type, statement: c.statement, statedAt: c.statedAt })));
      let linked = 0; const nid = new Set(newIds);
      for (const l of links) if (nid.has(l.candidateId) || nid.has(l.relatedId)) { ai.addLink(l); linked++; }
      const status = created + extended > 0 ? 'REVIEW_REQUIRED' : 'DONE';
      ai.updateImport(importId, { distillStatus: status });
      log('info', { importId, stage: 'DISTILL', created, extended, linked, llm: llm.status }, 'NOTEBOOK_AI_DISTILL');
      return { ok: true, status, created, extended, groupedFrom: raw.length, possibleSupersessions: linked, llm: { ...llm, ...(llmOk ? llmStats : {}) }, method: llmOk ? 'rules+llm' : 'rules' };
    } catch (e) { ai.updateImport(importId, { distillStatus: 'NONE' }); throw e; }
  }

  // ── human review — the ONLY way a candidate changes status ─────────────────
  const REVIEW_ACTIONS = ['approve', 'reject', 'edit', 'supersede', 'reopen'];
  function reviewCandidate(notebookId, candidateId, action, payload = {}) {
    if (!REVIEW_ACTIONS.includes(action)) throw new NotebookImportError('INVALID_OPTION', `Action de revue inconnue : ${action} (aucune approbation automatique ou en masse n'existe)`);
    const c = ai.getCandidate(notebookId, candidateId);
    if (!c) return { ok: false, error: 'NOT_FOUND' };
    if (action === 'approve') ai.updateCandidate(candidateId, { status: 'APPROVED', promotion: 'NOTEBOOK_ONLY' }); // there is no global memory: approval never leaves the Notebook
    else if (action === 'reject') ai.updateCandidate(candidateId, { status: 'REJECTED', promotion: 'NONE' });
    else if (action === 'reopen') ai.updateCandidate(candidateId, { status: 'CANDIDATE', promotion: 'NONE' });
    else if (action === 'edit') {
      const st = String(payload.statement ?? '').trim();
      if (st.length < 3 || st.length > 400) throw new NotebookImportError('INVALID_OPTION', 'Énoncé invalide (3–400 caractères)');
      if (detectInjection(st).flagged) throw new NotebookImportError('INVALID_OPTION', 'Énoncé refusé : ressemble à une instruction');
      ai.updateCandidate(candidateId, { statement: st, edited: true });
    } else if (action === 'supersede') {
      const by = ai.getCandidate(notebookId, String(payload.supersededBy ?? ''));
      if (!by) throw new NotebookImportError('INVALID_OPTION', 'Candidat remplaçant introuvable');
      ai.updateCandidate(candidateId, { status: 'SUPERSEDED' });
      ai.addLink({ candidateId: by.candidateId, relatedId: candidateId, kind: 'POSSIBLE_SUPERSEDES', ambiguous: 0, detail: 'confirmé par l\'utilisateur' });
    }
    return { ok: true, candidate: ai.getCandidate(notebookId, candidateId) };
  }
  const getCandidateDetail = (notebookId, id) => {
    const c = ai.getCandidate(notebookId, id); if (!c) return null;
    const evidence = ai.listEvidence(id); const convs = ai.getConversationsByIds([...new Set(evidence.map(e => e.conversationId))]);
    return { ...c, evidence: evidence.map(e => ({ ...e, conversationTitle: convs.get(e.conversationId)?.title ?? '', provider: convs.get(e.conversationId)?.provider ?? 'UNKNOWN' })), links: ai.listLinks(id) };
  };

  // ── search over the imported histories (FTS + vectors, role/provider/date/… filters) ─
  function normalizeFilters(f = {}) {
    const providers = f.providers ?? (f.provider ? [f.provider] : null);
    if (providers && providers.some(p => !PROVIDERS.includes(p))) throw new NotebookImportError('INVALID_OPTION', 'provider invalide');
    const roles = f.roles ?? (f.role ? [f.role] : (f.userOnly ? ['USER'] : (f.aiOnly ? ['ASSISTANT'] : null)));
    if (roles && roles.some(r => !ROLES.includes(r))) throw new NotebookImportError('INVALID_OPTION', 'rôle invalide');
    const iso = (v, k) => { if (v == null || v === '') return null; const x = toIso(v); if (!x) throw new NotebookImportError('INVALID_OPTION', `date invalide (${k})`); return x; };
    const to = iso(f.to, 'to');
    return { providers, roles, from: iso(f.from, 'from'), to: to && /^\d{4}-\d{2}-\d{2}$/.test(String(f.to)) ? `${String(f.to)}T23:59:59.999Z` : to, conversationIds: f.conversationIds ?? null, importIds: f.importIds ?? null, trustLevels: f.trustLevels ?? null, mainPathOnly: f.mainPathOnly === true };
  }

  function enrich(results) {
    const convs = ai.getConversationsByIds([...new Set(results.map(r => r.aiConversationId).filter(Boolean))]);
    return results.map(r => {
      const conv = convs.get(r.aiConversationId); const provider = r.aiProvider ?? conv?.provider ?? 'UNKNOWN';
      return {
        ...r, type: 'AI_HISTORY_MESSAGE', importId: r.documentId, conversationId: r.aiConversationId, conversationTitle: conv?.title ?? '', provider, providerLabel: PROVIDER_LABEL[provider] ?? PROVIDER_LABEL.UNKNOWN,
        providerVerified: conv?.providerVerified ?? false, role: r.aiRole, messageIds: r.aiMessageIds ?? [], primaryMessageId: (r.aiMessageIds ?? [])[0] ?? null, date: r.aiTs ?? conv?.createdAt ?? null,
        speaker: speakerFor(r.aiRole, provider), assertionType: assertionTypeFor(r.trustLevel),
        sourceTitle: `${PROVIDER_LABEL[provider] ?? PROVIDER_LABEL.UNKNOWN} — ${conv?.title || '(sans titre)'}`, branch: r.aiBranch === true,
      };
    });
  }

  async function search(notebookId, query, opts = {}) {
    const filter = { scope: 'ai_history', ...normalizeFilters(opts.filters ?? opts) };
    const found = await docService.search(notebookId, query, { topK: opts.topK, profile: opts.profile, useVector: opts.useVector, config: { diversityBy: 'conversation', ...(opts.config ?? {}) }, filter });
    return { ...found, results: enrich(found.results) };
  }

  const citationOf = (c, i) => ({
    type: 'AI_HISTORY_MESSAGE', ref: i + 1, chunkId: c.chunkId, importId: c.importId, conversationId: c.conversationId, conversationTitle: c.conversationTitle, provider: c.provider, providerLabel: c.providerLabel,
    providerVerified: c.providerVerified, role: c.role, trustLevel: c.trustLevel, assertionType: c.assertionType, verification: c.assertionType === 'PAST_AI_ASSERTION' ? 'UNVERIFIED_PAST_AI' : 'USER_STATEMENT',
    messageIds: c.messageIds, primaryMessageId: c.primaryMessageId, date: c.date, speaker: c.speaker, hash: c.hash, branch: c.branch, passage: c.text.slice(0, 300),
  });

  async function ask(notebookId, question, opts = {}) {
    const found = await search(notebookId, question, opts);
    const cfg = { ...found.config };
    const budget = applyContextBudget(found.results, { ...cfg, diversityBy: 'conversation' });
    const base = { retrievalMode: found.retrievalMode, vectorStatus: found.vectorStatus, mode: found.mode, confidence: confidenceLevel(found.results), diagnostics: { ...found.diagnostics, contextTokens: budget.tokensUsed } };
    if (!budget.chunks.length) return { ...base, status: 'NO_RELEVANT_SOURCE', answer: 'Aucun message pertinent dans les historiques IA importés pour cette question.', citations: [], uncertainties: [{ code: 'NO_RELEVANT_SOURCE', message: 'Aucun extrait n\'a passé les seuils ; le LLM n\'a pas été appelé.' }], sourceConflicts: [], sourcesUsed: [], chunksUsed: 0, confidence: 'NONE' };
    const pack = buildCitationPack(question, budget.chunks.map(c => ({ ...c, sourceTitle: c.sourceTitle, documentVersion: 1, versionId: c.importId })));
    const conflictInput = pack.chunks.map((c, i) => ({ ...c, documentId: `${budget.chunks[i].conversationId ?? budget.chunks[i].documentId}|${budget.chunks[i].role}`, importedAt: budget.chunks[i].date, isCurrent: true }));
    const sourceConflicts = detectConflicts(conflictInput);
    const { messages } = buildDocumentMessages(pack, { conflicts: sourceConflicts, systemPrompt: AI_HISTORY_SYSTEM_PROMPT });
    const answer = String(await deps.localComplete(messages) ?? '');
    const used = new Set(); const re = /\[(\d+)\]/g; let m;
    while ((m = re.exec(answer)) !== null) { const idx = Number(m[1]) - 1; if (idx >= 0 && idx < budget.chunks.length) used.add(idx); }
    const citations = [];
    for (const i of [...used].sort((a, b) => a - b)) { const c = budget.chunks[i]; if (verifyCitation(notebookId, { chunkId: c.chunkId, hash: c.hash }).valid) citations.push(citationOf(c, i)); }
    const uncertainties = [];
    if (!citations.length) uncertainties.push({ code: 'NO_CITATION_IN_ANSWER', message: 'La réponse ne cite aucun message : inférence non vérifiée.' });
    const allAi = budget.chunks.every(c => c.assertionType === 'PAST_AI_ASSERTION');
    if (allAi) uncertainties.push({ code: 'ONLY_PAST_AI_SOURCES', message: 'Toutes les sources sont d\'anciennes réponses d\'IA importées : non vérifiées (peuvent être fausses ou périmées).' });
    else if (budget.chunks.some(c => c.assertionType === 'PAST_AI_ASSERTION')) uncertainties.push({ code: 'PAST_AI_SOURCE_USED', message: 'Une des sources est une ancienne réponse d\'IA (non vérifiée).' });
    if (sourceConflicts.length) uncertainties.push({ code: 'SOURCE_CONFLICT', message: `${sourceConflicts.length} conflit(s) possible(s) entre messages (heuristique) : ne pas fusionner.` });
    const dates = budget.chunks.map(c => c.date).filter(Boolean).sort();
    if (dates.length > 1 && Date.parse(dates.at(-1)) - Date.parse(dates[0]) > 30 * 86400_000) uncertainties.push({ code: 'TEMPORAL_MIX', message: `Les sources s'étalent du ${dates[0].slice(0, 10)} au ${dates.at(-1).slice(0, 10)} : état historique, pas forcément l'état actuel.` });
    if (found.retrievalMode === 'FTS_ONLY') uncertainties.push({ code: 'FTS_ONLY', message: 'Recherche texte locale uniquement.' });
    if (budget.chunks.some(c => (c.injectionFlags ?? []).length)) uncertainties.push({ code: 'INJECTION_TEXT_IN_SOURCE', message: 'Un message contient du texte d\'instruction (traité comme donnée).' });
    if (budget.chunks.some(c => c.branch)) uncertainties.push({ code: 'ALTERNATE_BRANCH', message: 'Un extrait provient d\'une branche alternative (réponse régénérée / éditée).' });
    const voices = [...new Map(budget.chunks.map(c => [`${c.role}|${c.provider}`, { role: c.role, provider: c.provider, speaker: c.speaker }])).values()];
    return { ...base, status: 'ANSWERED', answer, citations, uncertainties, sourceConflicts, voices, sourcesUsed: [...new Map(budget.chunks.map(c => [c.conversationId, { conversationId: c.conversationId, conversationTitle: c.conversationTitle, provider: c.provider, importId: c.importId }])).values()], chunksUsed: budget.chunks.length };
  }

  // A citation is valid only if its chunk still exists in THIS notebook, is visible, and its text hash is unchanged.
  function verifyCitation(notebookId, { chunkId, hash }) {
    const row = docService.resolveCitation(notebookId, chunkId);
    if (!row || !row.aiConversationId) return { valid: false, reason: 'NOT_FOUND' };
    if (hash && row.hash !== hash) return { valid: false, reason: 'HASH_MISMATCH' };
    return { valid: true, row };
  }

  // Exact chunk + the real messages behind it (never a re-derived excerpt).
  function previewCitation(notebookId, chunkId) {
    const v = verifyCitation(notebookId, { chunkId }); if (!v.valid) return null;
    const row = v.row; const conv = ai.getConversation(row.aiConversationId);
    const messages = ai.getMessages(notebookId, row.aiMessageIds ?? []).sort((a, b) => a.ordinal - b.ordinal);
    const atts = ai.listAttachments(notebookId, messages.map(m => m.messageId));
    return {
      type: 'AI_HISTORY_MESSAGE', chunkId, importId: row.documentId, conversationId: row.aiConversationId, conversationTitle: conv?.title ?? '', provider: row.aiProvider, providerLabel: PROVIDER_LABEL[row.aiProvider] ?? PROVIDER_LABEL.UNKNOWN,
      providerVerified: conv?.providerVerified ?? false, role: row.aiRole, trustLevel: row.trustLevel, assertionType: assertionTypeFor(row.trustLevel), date: row.aiTs, hash: row.hash, text: row.text, branch: row.aiBranch,
      messages: messages.map(m => ({ messageId: m.messageId, role: m.role, createdAt: m.createdAt, originalId: m.originalId, trustLevel: m.trustLevel, content: m.content, onMainPath: m.onMainPath, isCurrent: m.isCurrent, flags: m.flags })),
      attachments: atts,
    };
  }

  // Embeds chunks lacking a compatible vector (after VECTOR_UNAVAILABLE) — explicit action.
  async function reindexImport(notebookId, importId) {
    const imp = ai.getImport(importId); if (!imp || imp.notebookId !== notebookId) return { ok: false, error: 'SOURCE_DELETED' };
    const chunks = dstore.getCurrentChunkRows(importId); if (!chunks.length) return { ok: true, reindexed: 0 };
    let vectors; try { vectors = await I.embedChunks(chunks); } catch { return { ok: false, error: 'EMBEDDING_UNAVAILABLE', reindexed: 0 }; }
    await I.purgeVectors(chunks.map(c => c.chunkId)); dstore.deleteEmbeddingsForChunks(chunks.map(c => c.chunkId));
    await I.storeVectors({ notebookId, documentId: importId }, { versionId: importId }, chunks, vectors);
    return { ok: true, reindexed: chunks.length };
  }

  return {
    preview, startImport, importHistory, cancelImport, deleteImport, distill, reviewCandidate, getCandidateDetail, reindexImport,
    search, ask, verifyCitation, previewCitation, normalizeFilters, enrich, speakerFor,
    getImport: (nb, id) => { const i = ai.getImport(id); return i && i.notebookId === nb ? i : null; },
    listImports: (nb, o) => ai.listImports(nb, o), countImports: (nb) => ai.countImports(nb),
    listConversations: (nb, o) => ai.listConversations(nb, { ...o, sessionId: I.sessionId, nowIso: nowIso() }),
    countConversations: (nb, o) => ai.countConversations(nb, { ...o, sessionId: I.sessionId, nowIso: nowIso() }),
    getConversation: (nb, id) => { const c = ai.getConversation(id); return c && c.notebookId === nb ? c : null; },
    listMessages: (nb, cid, o) => { const c = ai.getConversation(cid); return c && c.notebookId === nb ? ai.listMessages(nb, cid, o) : null; },
    countMessages: (nb, cid) => ai.countMessages(nb, cid),
    getMessage: (nb, id) => ai.getMessage(nb, id),
    listAttachments: (nb, ids) => ai.listAttachments(nb, ids),
    listCandidates: (nb, o) => ai.listCandidates(nb, o), countCandidates: (nb, s) => ai.countCandidates(nb, s),
    adapters: ADAPTERS.map(a => ({ id: a.id, provider: a.provider, syntheticOnly: a.provider !== 'UNKNOWN' })),
    limits, zipLimits,
  };
}
