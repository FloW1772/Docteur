// Companion V1 — COMP-2 session context (process memory only).
//
// SESSION_CONTEXT never touches SQLite or the disk: it lives in this object and dies with it (end of session, idle
// timeout, maximum lifetime, explicit purge, process restart). It is scoped by an unguessable session id: a session
// never sees another one, and an unknown, expired or purged id answers the same SESSION_NOT_FOUND.
// Nothing here is ever promoted to durable memory: the only way to durable memory is a proposal the user accepts
// (companion-memory.js). Secrets are refused (REFUSE_MEMORY). Bounded: items, bytes, item size, sessions.

import crypto from 'node:crypto';
import { fail, limit, cleanText, cleanSourceReference, freezeDeep, SESSION_CATEGORIES } from './companion-contracts.js';
import { detectSecretMemory } from './companion-secrets.js';

const notFound = () => fail('COMP_SESSION_NOT_FOUND', 'session not found');

export class CompanionSessionStore {
  #sessions = new Map();
  #now;
  #isEnabled;

  /**
   * @param {{ now?: () => number, isEnabled?: () => boolean }} opts isEnabled = memoryEnabled && sessionMemoryEnabled
   */
  constructor({ now = Date.now, isEnabled = () => true } = {}) {
    this.#now = now;
    this.#isEnabled = isEnabled;
    Object.freeze(this);
  }

  #sweep() {
    const t = this.#now();
    for (const [id, s] of this.#sessions) if (t - s.lastActivity > limit('sessionIdleMs') || t - s.createdAt > limit('sessionLifetimeMs')) this.#sessions.delete(id);
  }
  #get(sessionId) {
    this.#sweep();
    if (typeof sessionId !== 'string') notFound();
    return this.#sessions.get(sessionId) ?? notFound();
  }
  #requireEnabled() { if (!this.#isEnabled()) fail('COMP_MEMORY_DISABLED', 'Companion session memory is off'); }

  openSession() {
    this.#requireEnabled();
    this.#sweep();
    if (this.#sessions.size >= limit('sessions')) fail('COMP_LIMIT_REACHED', `at most ${limit('sessions')} open sessions`);
    const id = crypto.randomBytes(24).toString('base64url');
    const t = this.#now();
    this.#sessions.set(id, { createdAt: t, lastActivity: t, items: [], bytes: 0 });
    return id;
  }

  /**
   * Adds one item. category ∈ SESSION_CONTEXT / DERIVED_CONTEXT / TASK_CONTEXT / SOURCE_REFERENCE.
   *   TASK_CONTEXT needs a taskId; SOURCE_REFERENCE is a reference ({ kind, ref, label }) and carries NO text.
   * The oldest items are dropped first when the item / byte budget is exceeded (bounded, reported).
   */
  add(sessionId, { category, text = null, role = null, taskId = null, reference = null } = {}) {
    this.#requireEnabled();
    const s = this.#get(sessionId);
    if (!SESSION_CATEGORIES.includes(category)) fail('COMP_UNKNOWN_CATEGORY', 'not a session category (durable categories go through proposals)');
    let item;
    if (category === 'SOURCE_REFERENCE') {
      if (text !== null) fail('COMP_SOURCE_COPY_REFUSED', 'a SOURCE_REFERENCE is a reference, never a copy of the source');
      item = { category, reference: cleanSourceReference(reference) ?? fail('COMP_REQUIRED_FIELD', 'reference is required') };
    } else {
      const t = cleanText(text, limit('sessionItemChars'), 'text', { required: true });
      const secret = detectSecretMemory(t);
      if (secret.refused) fail('COMP_REFUSE_MEMORY', 'secret detected: not kept, even for this session', { kinds: secret.kinds });
      if (category === 'TASK_CONTEXT' && !taskId) fail('COMP_REQUIRED_FIELD', 'TASK_CONTEXT is bound to a taskId');
      if (category !== 'TASK_CONTEXT' && taskId) fail('COMP_INVALID_FIELD', 'only TASK_CONTEXT carries a taskId');
      if (role !== null && !['user', 'assistant'].includes(role)) fail('COMP_INVALID_FIELD', 'role is user or assistant');
      item = { category, text: t, role, taskId: taskId ? cleanText(taskId, 64, 'taskId', { multiline: false }) : null };
    }
    item.id = crypto.randomUUID();
    item.at = new Date(this.#now()).toISOString();
    item.bytes = Buffer.byteLength(JSON.stringify(item));
    s.items.push(item); s.bytes += item.bytes; s.lastActivity = this.#now();
    let dropped = 0;
    while (s.items.length > limit('sessionItems') || s.bytes > limit('sessionBytes')) { s.bytes -= s.items.shift().bytes; dropped++; }
    return Object.freeze({ id: item.id, dropped });
  }

  /** Items of ONE session (oldest first). Memory OFF ⇒ nothing is returned. */
  list(sessionId, { category = null, taskId = null } = {}) {
    if (!this.#isEnabled()) return [];
    const s = this.#get(sessionId);
    s.lastActivity = this.#now();
    return s.items.filter(i => (category === null || i.category === category) && (taskId === null || i.taskId === taskId))
      .map(({ bytes, ...rest }) => freezeDeep({ ...rest, durable: false }));
  }

  /** Removes the items that reference a forgotten object (forget coordination). Returns the count removed. */
  purgeReferences(ref) {
    let n = 0;
    for (const s of this.#sessions.values()) {
      const keep = s.items.filter(i => !(i.reference?.ref === ref));
      n += s.items.length - keep.length;
      s.items = keep; s.bytes = keep.reduce((a, i) => a + i.bytes, 0);
    }
    return n;
  }
  hasReference(ref) { return [...this.#sessions.values()].some(s => s.items.some(i => i.reference?.ref === ref)); }

  endSession(sessionId) { this.#get(sessionId); this.#sessions.delete(sessionId); }
  purgeAll() { const n = this.#sessions.size; this.#sessions.clear(); return n; }
  stats() { this.#sweep(); return Object.freeze({ sessions: this.#sessions.size, items: [...this.#sessions.values()].reduce((a, s) => a + s.items.length, 0) }); }
}
