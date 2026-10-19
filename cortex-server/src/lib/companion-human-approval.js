// Companion V1 — COMP-6A human approval channel (no route, no wiring; process memory only).
//
// COMP-5 left one gap: an approval said approvedBy USER, but nothing tied it to a gesture in the UI. In the product
// mode of createCompanionActions the plain user.approve() is refused (HUMAN_GESTURE_REQUIRED); the ONLY approver is
// this channel, built inside the framework closure, so no other module can reach the internal approve:
//   1. openUiSession()                      → an unguessable uiSessionId (one per UI surface; dies with the process)
//   2. issueChallenge({ uiSessionId, proposalId })
//        the server reads the PENDING proposal, re-checks its preview, and binds a single-use nonce (≤ 120 s) to
//        uiSessionId + proposalId + actionDigest + previewSha256 + confirmationKind (+ phrase / acknowledgements)
//   3. the UI renders the preview; ONLY a trusted user gesture (pointer / keyboard event, isTrusted) builds a
//      HumanApprovalIntent { proposalId, actionDigest, confirmationKind, uiSessionId, nonce, createdAt, gesture,
//      typedPhrase?, acknowledgements? } — strict: any other field (humanConfirmed, approved, approvedBy …) is refused
//   4. submitIntent(intent) → shape, session, nonce (unknown / replayed / expired), binding (proposal, digest, kind,
//      session), clock window, gesture, phrase, acknowledgements; the nonce is consumed; THEN the COMP-5 approve runs
//      and re-validates proposal, digest, expiry, preview and phrase itself (the UI is never the security authority).
// What this proves: the approval answers a challenge the server issued to a UI session for exactly this proposal /
// digest / preview, once, within 120 s, with the confirmation the preview demands. It is a channel binding, not a
// cryptographic proof that a person (and not a script with access to the same UI session) clicked.

import crypto from 'node:crypto';
import { freezeDeep } from './companion-contracts.js';
import { ACTION_ERROR, deny } from './companion-action-registry.js';

/** COMP-5 preview confirmation level → UI confirmation kind. READ_ONLY needs none. */
export const CONFIRMATION_KIND = Object.freeze({ STANDARD: 'SIMPLE_CONFIRM', EXPLICIT: 'TYPED_CONFIRM', REINFORCED: 'REINFORCED_CONFIRM' });
export const CONFIRMATION_KINDS = Object.freeze(['SIMPLE_CONFIRM', 'TYPED_CONFIRM', 'REINFORCED_CONFIRM']);
/** A REINFORCED confirmation = these acknowledgements (checkboxes) AND the exact typed phrase. */
export const REINFORCED_ACKNOWLEDGEMENTS = Object.freeze(['CURRENT_SCOPE_LEAVES_NEVER_CLOUD', 'FUTURE_CLOUD_USE_POSSIBLE']);
export const GESTURE_KINDS = Object.freeze(['POINTER', 'KEYBOARD']);
export const INTENT_FIELDS = Object.freeze(['proposalId', 'actionDigest', 'confirmationKind', 'uiSessionId', 'nonce', 'createdAt', 'gesture', 'typedPhrase', 'acknowledgements']);
export const INTENT_ERROR = Object.freeze({ APPROVAL_INTENT_INVALID: 'APPROVAL_INTENT_INVALID', APPROVAL_INTENT_EXPIRED: 'APPROVAL_INTENT_EXPIRED', APPROVAL_INTENT_REPLAYED: 'APPROVAL_INTENT_REPLAYED', APPROVAL_INTENT_MISMATCH: 'APPROVAL_INTENT_MISMATCH', UI_SESSION_UNKNOWN: 'UI_SESSION_UNKNOWN' });
/** Bounds. PROVISIONAL; each has its basis. */
export const GESTURE_LIMITS = freezeDeep({
  challengeTtlMs: { value: 120_000, status: 'PROVISIONAL', basis: 'the time to read a preview and confirm; never longer than the default approval TTL' },
  clockSkewMs: { value: 5_000, status: 'PROVISIONAL', basis: 'createdAt comes from the UI clock: tolerance only, never trusted for expiry' },
  uiSessions: { value: 8, status: 'PROVISIONAL', basis: 'single-user install: a few open windows' },
  challengesPerSession: { value: 16, status: 'PROVISIONAL', basis: 'a review list, not a queue' },
  consumedNonces: { value: 512, status: 'PROVISIONAL', basis: 'enough to recognise a replay in a working session' },
  typedPhraseChars: { value: 200, status: 'PROVISIONAL', basis: 'the longest COMP-5 phrase is ~90 characters' },
});
const SESSION_RE = /^[A-Za-z0-9_-]{32}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const bad = (code, reason, message = 'approval intent refused') => deny(code, message, { reason });
export const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/** Strict shape of a HumanApprovalIntent (no authority by itself: the binding is checked against the challenge). */
export function validateIntentShape(intent) {
  if (!isPlain(intent)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'NOT_AN_OBJECT');
  for (const k of Object.keys(intent)) if (!INTENT_FIELDS.includes(k)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'UNKNOWN_FIELD');
  const { proposalId, actionDigest, confirmationKind, uiSessionId, nonce, createdAt, gesture, typedPhrase, acknowledgements } = intent;
  if (typeof proposalId !== 'string' || !UUID_RE.test(proposalId)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'PROPOSAL_ID');
  if (typeof actionDigest !== 'string' || !HEX64.test(actionDigest)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'ACTION_DIGEST');
  if (!CONFIRMATION_KINDS.includes(confirmationKind)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'CONFIRMATION_KIND');
  if (typeof uiSessionId !== 'string' || !SESSION_RE.test(uiSessionId)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'UI_SESSION_ID');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'NONCE');
  if (typeof createdAt !== 'string' || !ISO_RE.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'CREATED_AT');
  if (!isPlain(gesture) || Object.keys(gesture).sort().join(',') !== 'kind,trusted' || !GESTURE_KINDS.includes(gesture.kind) || gesture.trusted !== true) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'GESTURE');
  if (typedPhrase !== undefined && (typeof typedPhrase !== 'string' || typedPhrase.length > GESTURE_LIMITS.typedPhraseChars.value)) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'TYPED_PHRASE');
  if (acknowledgements !== undefined && (!Array.isArray(acknowledgements) || acknowledgements.length > 8 || acknowledgements.some(a => typeof a !== 'string' || a.length > 64))) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'ACKNOWLEDGEMENTS');
  return intent;
}

/**
 * @param {object} deps (given by createCompanionActions only)
 *   getPending(proposalId) → { proposalId, actionId, riskClass, digest, previewSha256, preview, previewStale, status, expired } (throws when unknown)
 *   approve(proposalId, { digest, confirmationPhrase }, channel) → the COMP-5 approval (re-validates everything)
 *   refuse(error, ctx) → audits ACTION_DENIED and throws
 *   clock() → ms
 */
export function createHumanApprovalChannel({ getPending, approve, refuse, clock }) {
  const sessions = new Map(); // uiSessionId → { openedAt, challenges: Map<nonce, challenge> }
  const consumed = new Map(); // nonce → consumedAt (bounded, for replay recognition)
  const remember = (nonce) => { consumed.set(nonce, clock()); while (consumed.size > GESTURE_LIMITS.consumedNonces.value) consumed.delete(consumed.keys().next().value); };
  const guarded = (fn, ctx = () => ({})) => { try { return fn(); } catch (e) { return refuse(e, ctx()); } };

  function openUiSession() {
    while (sessions.size >= GESTURE_LIMITS.uiSessions.value) sessions.delete(sessions.keys().next().value);
    const uiSessionId = crypto.randomBytes(24).toString('base64url');
    sessions.set(uiSessionId, { openedAt: clock(), challenges: new Map() });
    return Object.freeze({ uiSessionId });
  }
  function closeUiSession(uiSessionId) {
    const s = sessions.get(uiSessionId);
    if (s) for (const nonce of s.challenges.keys()) remember(nonce);
    return sessions.delete(uiSessionId);
  }
  const session = (uiSessionId) => (typeof uiSessionId === 'string' && sessions.get(uiSessionId)) || bad(INTENT_ERROR.UI_SESSION_UNKNOWN, 'UI_SESSION_UNKNOWN', 'unknown UI session');

  /** Server-side challenge for one PENDING LOCAL_MUTATION proposal. Re-issuing for the same proposal replaces the previous nonce. */
  function issueChallenge({ uiSessionId, proposalId } = {}) {
    return guarded(() => {
      const s = session(uiSessionId);
      const p = getPending(proposalId);
      if (p.riskClass !== 'LOCAL_MUTATION') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'a READ_ONLY action needs no approval', { reason: 'APPROVAL_NOT_APPLICABLE' });
      if (p.status !== 'PENDING') deny(ACTION_ERROR.ACTION_NOT_ALLOWED, `this proposal is ${p.status}`, { reason: `PROPOSAL_${p.status}` });
      if (p.expired) deny(ACTION_ERROR.PROPOSAL_EXPIRED, 'this proposal expired: propose again', { reason: 'PROPOSAL_EXPIRED' });
      if (p.previewStale || !p.preview) deny(ACTION_ERROR.PREVIEW_STALE, 'the state changed since the preview: propose again', { reason: 'PREVIEW_STALE' });
      for (const [n, c] of s.challenges) if (c.proposalId === p.proposalId || clock() >= c.expiresAt) { s.challenges.delete(n); remember(n); }
      if (s.challenges.size >= GESTURE_LIMITS.challengesPerSession.value) deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'too many open confirmations in this UI session', { reason: 'TOO_MANY_CHALLENGES' });
      const level = p.preview.confirmation?.level;
      const confirmationKind = CONFIRMATION_KIND[level] ?? deny(ACTION_ERROR.ACTION_NOT_ALLOWED, 'unknown confirmation level', { reason: 'UNKNOWN_CONFIRMATION_LEVEL' });
      const nonce = crypto.randomBytes(24).toString('base64url');
      const issuedAt = clock();
      const c = {
        nonce, uiSessionId, proposalId: p.proposalId, actionId: p.actionId, actionDigest: p.digest, previewSha256: p.previewSha256, confirmationKind,
        phrase: confirmationKind === 'SIMPLE_CONFIRM' ? null : p.preview.confirmation.phrase,
        acknowledgements: confirmationKind === 'REINFORCED_CONFIRM' ? [...REINFORCED_ACKNOWLEDGEMENTS] : [],
        issuedAt, expiresAt: Math.min(issuedAt + GESTURE_LIMITS.challengeTtlMs.value, Date.parse(p.expiresAt)),
      };
      s.challenges.set(nonce, c);
      return freezeDeep({ nonce, uiSessionId, proposalId: c.proposalId, actionId: c.actionId, actionDigest: c.actionDigest, previewSha256: c.previewSha256, confirmationKind,
        typedPhrase: c.phrase, requiredAcknowledgements: c.acknowledgements, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(c.expiresAt).toISOString() });
    }, () => ({ proposalId: typeof proposalId === 'string' && UUID_RE.test(proposalId) ? proposalId : null }));
  }

  /** The only path to an approval in product mode. Returns the COMP-5 approval. */
  function submitIntent(intent) {
    let c = null;
    return guarded(() => {
      validateIntentShape(intent);
      const s = session(intent.uiSessionId);
      if (consumed.has(intent.nonce)) bad(INTENT_ERROR.APPROVAL_INTENT_REPLAYED, 'NONCE_ALREADY_USED', 'this confirmation was already used');
      c = s.challenges.get(intent.nonce) ?? null;
      if (!c) {
        if ([...sessions.values()].some(o => o.challenges.has(intent.nonce))) bad(INTENT_ERROR.APPROVAL_INTENT_MISMATCH, 'OTHER_UI_SESSION', 'this confirmation belongs to another UI session');
        bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'UNKNOWN_NONCE', 'no confirmation was issued for this nonce');
      }
      const burn = () => { s.challenges.delete(c.nonce); remember(c.nonce); };
      if (clock() >= c.expiresAt) { burn(); bad(INTENT_ERROR.APPROVAL_INTENT_EXPIRED, 'CHALLENGE_EXPIRED', 'this confirmation expired: confirm again'); }
      if (intent.proposalId !== c.proposalId) { burn(); bad(INTENT_ERROR.APPROVAL_INTENT_MISMATCH, 'PROPOSAL_DIFFERS', 'this confirmation was issued for another proposal'); }
      if (intent.actionDigest !== c.actionDigest) { burn(); deny(ACTION_ERROR.APPROVAL_DIGEST_MISMATCH, 'the confirmed digest is not the previewed one', { reason: 'INTENT_DIGEST_DIFFERS' }); }
      if (intent.confirmationKind !== c.confirmationKind) { burn(); bad(INTENT_ERROR.APPROVAL_INTENT_MISMATCH, 'CONFIRMATION_KIND_DIFFERS', 'wrong confirmation kind'); }
      const created = Date.parse(intent.createdAt);
      if (created < c.issuedAt - GESTURE_LIMITS.clockSkewMs.value || created > clock() + GESTURE_LIMITS.clockSkewMs.value) { burn(); bad(INTENT_ERROR.APPROVAL_INTENT_EXPIRED, 'CREATED_OUTSIDE_CHALLENGE_WINDOW', 'this confirmation is outside its time window'); }
      // a typo in the phrase or a missing checkbox does not burn the challenge: the person corrects it
      if (c.phrase !== null && intent.typedPhrase !== c.phrase) deny(ACTION_ERROR.CONFIRMATION_REQUIRED, 'the typed phrase does not match exactly', { reason: `${c.confirmationKind}_PHRASE_MISMATCH` });
      if (c.phrase === null && intent.typedPhrase !== undefined) bad(INTENT_ERROR.APPROVAL_INTENT_INVALID, 'UNEXPECTED_TYPED_PHRASE');
      const acks = intent.acknowledgements ?? [];
      if (c.acknowledgements.length ? (acks.length !== c.acknowledgements.length || c.acknowledgements.some(a => !acks.includes(a))) : acks.length) {
        deny(ACTION_ERROR.CONFIRMATION_REQUIRED, 'every acknowledgement must be checked', { reason: 'ACKNOWLEDGEMENTS_REQUIRED' });
      }
      burn(); // single use: consumed BEFORE the approval is attempted
      return approve(c.proposalId, { digest: c.actionDigest, confirmationPhrase: c.phrase, expectedPreviewSha256: c.previewSha256 },
        { channel: 'UI_GESTURE', uiSession: shortHash(c.uiSessionId), nonce: shortHash(c.nonce), confirmationKind: c.confirmationKind, gesture: intent.gesture.kind });
    }, () => ({ proposalId: c?.proposalId ?? null, digest: c?.actionDigest ?? null, actionId: c?.actionId ?? null }));
  }

  const stats = () => Object.freeze({ uiSessions: sessions.size, openChallenges: [...sessions.values()].reduce((n, s) => n + s.challenges.size, 0), consumedNonces: consumed.size });
  return Object.freeze({ openUiSession, closeUiSession, issueChallenge, submitIntent, stats });
}
