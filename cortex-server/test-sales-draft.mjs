import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftOutreachMessage, draftCrmNote } from './src/lib/sales-draft.js';

// ── Outreach message draft ───────────────────────────────────────────────

test('outreach draft is labeled DRAFT — NOT SENT and sent:false', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane', company: 'Acme' } });
  assert.equal(draft.status, 'DRAFT — NOT SENT');
  assert.equal(draft.sent, false);
});

test('outreach draft body includes lead name and company', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane Doe', company: 'Acme Corp' } });
  assert.ok(draft.body.includes('Jane Doe'));
  assert.ok(draft.body.includes('Acme Corp'));
});

test('outreach draft carries a disclaimer that it is never sent automatically', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane' } });
  assert.ok(draft.disclaimer.toLowerCase().includes('jamais'));
});

test('missing lead name throws, never drafts a message for nobody', () => {
  assert.throws(() => draftOutreachMessage({ lead: {} }));
});

test('score matched factors are included in the draft body as context', () => {
  const score = { matched: [{ id: 'a', label: 'Hiring engineers' }] };
  const draft = draftOutreachMessage({ lead: { name: 'Jane' }, score });
  assert.ok(draft.body.includes('Hiring engineers'));
});

test('no matched factors: draft says context must be completed manually', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane' }, score: { matched: [] } });
  assert.ok(draft.body.includes('à compléter manuellement') || draft.body.includes('Aucun point'));
});

test('invalid tone falls back to neutral rather than injecting arbitrary text', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane' }, tone: 'aggressive-hard-sell' });
  assert.equal(draft.tone, 'neutral');
});

test('newlines in lead name/company cannot inject extra lines into the draft', () => {
  const draft = draftOutreachMessage({ lead: { name: 'Jane\nBcc: attacker@evil.com', company: 'Acme' } });
  assert.ok(!draft.body.includes('Bcc: attacker@evil.com\n'));
  assert.ok(!draft.subject.includes('\n'));
});

// ── CRM note draft ────────────────────────────────────────────────────────

test('crm note draft is labeled DRAFT — NOT SENT', () => {
  const draft = draftCrmNote({ lead: { name: 'Jane', company: 'Acme' }, score: { score: 80 }, sources: [{}, {}] });
  assert.equal(draft.status, 'DRAFT — NOT SENT');
  assert.equal(draft.kind, 'crm_note');
});

test('crm note includes score and source count when available', () => {
  const draft = draftCrmNote({ lead: { name: 'Jane' }, score: { score: 42 }, sources: [{}] });
  assert.ok(draft.note.includes('42/100'));
  assert.ok(draft.note.includes('1'));
});

test('crm note states no external action was taken automatically', () => {
  const draft = draftCrmNote({ lead: { name: 'Jane' }, score: null, sources: [] });
  assert.ok(draft.note.toLowerCase().includes('aucune action externe'));
});

test('missing lead name throws for crm note too', () => {
  assert.throws(() => draftCrmNote({ lead: {} }));
});
