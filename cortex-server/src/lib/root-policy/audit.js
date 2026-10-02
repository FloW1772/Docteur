/**
 * ROOT POLICY V1 — audit trail.
 *
 * Only relevant events are recorded (never one line per harmless operation): POLICY_LOADED, POLICY_INVALID, POLICY_TAMPER_DETECTED,
 * ACTION_DENIED, ACTION_REQUIRES_APPROVAL. Each line is chained to the previous one (sha256), so a deleted or edited line is detectable by
 * `verifyAuditChain`. Lines hold identifiers only (action, module, actor kind, stable code) — never secrets, prompts, URLs or content.
 * Repeated identical denials inside a window are coalesced (a counter is added to the next line) so a flood cannot fill the disk.
 * Auditing never alters a decision: every failure here is swallowed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_EVENTS = Object.freeze(['POLICY_LOADED', 'POLICY_INVALID', 'POLICY_TAMPER_DETECTED', 'ACTION_DENIED', 'ACTION_REQUIRES_APPROVAL']);
const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const GENESIS = '0'.repeat(64);

export function createAudit({ dir, logger = null, now = Date.now, windowMs = 60_000 } = {}) {
  const file = dir ? path.join(dir, 'audit.jsonl') : null;
  let prev = GENESIS;
  let seq = 0;
  const recent = new Map();
  const memory = [];

  if (file) {
    try {
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      const last = lines.at(-1) ? JSON.parse(lines.at(-1)) : null;
      if (last?.hash) { prev = last.hash; seq = Number(last.seq) || lines.length; }
    } catch { /* a damaged log is reported by verifyAuditChain, never thrown here */ }
  }

  function record(event, fields = {}) {
    try {
      if (!AUDIT_EVENTS.includes(event)) return false;
      const key = `${event}|${fields.code ?? ''}|${fields.action ?? ''}|${fields.module ?? ''}|${fields.actor ?? ''}`;
      const t = now();
      const last = recent.get(key);
      if (last && t - last.at < windowMs) { last.suppressed += 1; return false; }
      const suppressed = last?.suppressed ?? 0;
      recent.set(key, { at: t, suppressed: 0 });
      if (recent.size > 512) recent.delete(recent.keys().next().value);

      const entry = { t: new Date(t).toISOString(), seq: ++seq, event, ...pick(fields), ...(suppressed ? { suppressedSince: suppressed } : {}), prev };
      const hash = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      const line = JSON.stringify({ ...entry, hash });
      memory.push(JSON.parse(line)); if (memory.length > 200) memory.shift();
      prev = hash;
      logger?.warn?.({ event: `ROOT_POLICY_${event}`, ...pick(fields) }, `ROOT_POLICY_${event}`);
      if (file) {
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_AUDIT_BYTES) fs.renameSync(file, `${file}.${Date.now()}.old`);
        fs.appendFileSync(file, `${line}\n`, 'utf8');
      }
      return true;
    } catch { return false; }
  }

  return { record, recent: () => memory.slice(-50), file };
}

const pick = (f) => Object.fromEntries(['code', 'action', 'module', 'actor', 'domain', 'policyVersion', 'detail'].filter(k => f[k] !== undefined && f[k] !== null).map(k => [k, String(f[k]).slice(0, 200)]));

export function verifyAuditChain(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let prev = GENESIS;
    for (const [i, line] of lines.entries()) {
      const { hash, ...entry } = JSON.parse(line);
      if (entry.prev !== prev) return { ok: false, line: i + 1, reason: 'CHAIN_BROKEN' };
      if (crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex') !== hash) return { ok: false, line: i + 1, reason: 'HASH_MISMATCH' };
      prev = hash;
    }
    return { ok: true, lines: lines.length };
  } catch (error) { return { ok: false, reason: 'UNREADABLE', detail: error?.code }; }
}
