// C3c — credential shapes the historical cloud detector (Root Policy SECRET_SHAPES, unchanged) does not see are now
// blocked by the cloud choke point (privacy-guard.guardCloudCall) before any provider request: OpenAI project /
// service-account keys, Stripe secret keys, Hugging Face, GitLab, other GitHub token types, AWS temporary keys, any
// PEM / PGP private key block, age keys, Google OAuth client secrets, npm tokens and Telegram bot tokens.
// Run: node --test test-c3c-cloud-secret-shapes.mjs
//
// All secrets are FAKE and assembled at run time (prefix + filler), so no credential-looking literal is stored in
// the repository. Isolation: temporary database, Root Policy loaded read-only from ./policy with an in-memory audit,
// stubbed fetch (nothing is sent), no server started.
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSqlite, getDatabase, setRouterSettings, getPrivacyViolations } from './src/lib/sqlite.js';
import { guardCloudCall, containsCloudSecretShape, SecretExposureError, PrivacyViolationError } from './src/lib/privacy-guard.js';
import { complete as geminiComplete } from './src/lib/providers/gemini.js';
import { initRootPolicy, containsSecretShape } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c3c-'));
const fill = (n, alphabet = 'Fake0') => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
const UP = (n) => fill(n, 'FAKEX0');

// Fake secrets, one per new shape — each one is NOT caught by the historical Root Policy detector (asserted below).
const FAKE = {
  openai_project: `sk-${'proj'}-${fill(24)}_${fill(24)}`,
  openai_service: `sk-${'svcacct'}-${fill(40)}`,
  stripe_secret: `sk${'_live_'}${fill(24)}`,
  stripe_restricted: `rk${'_test_'}${fill(24)}`,
  huggingface: `hf${'_'}${fill(34)}`,
  gitlab: `glpat${'-'}${fill(20)}`,
  github_oauth: `gh${'o_'}${fill(36)}`,
  github_server: `gh${'s_'}${fill(36)}`,
  aws_temporary: `AS${'IA'}${UP(16)}`,
  pgp_private: `-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----\n${fill(40)}`,
  age_secret: `AGE-SECRET-${'KEY'}-1${UP(58)}`,
  google_oauth_secret: `GOC${'SPX'}-${fill(28)}`,
  npm_token: `npm${'_'}${fill(36)}`,
  telegram_bot: `${'123456789'}:AA${fill(33)}`,
};
// Ordinary text that must keep flowing to the cloud (no excessive false positives).
const BENIGN = [
  'Comment utiliser sk-learn et scikit-learn pour une régression ?',
  'Le préfixe hf_ désigne les jetons Hugging Face, ghs_ ceux des GitHub Apps.',
  'Voyage en ASIA en 2027 : itinéraire ASIAN-TOUR-2027.',
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa\n-----END CERTIFICATE-----',
  'const sk_live_mode = true; // a variable name, no value',
  'npm_config_cache et npm_lifecycle_event sont des variables npm.',
  'Rendez-vous à 12:30, salle AA-12.',
  'La clé publique age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs est partageable.',
  'Le projet sk-proj-docs est un nom de dossier.',
];
const msg = (content) => [{ role: 'user', content }];
const ALLOW = Object.freeze({ strict_local_mode: false, cloud_enabled: true, gemini_rpm: 60 });

let requests = 0;
const realFetch = globalThis.fetch;
before(() => {
  initSqlite(path.join(scratch, 'c3c.db'));
  initRootPolicy({ policyDir: path.join(HERE, 'policy'), trustAnchors: TRUST_ANCHORS });
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
});
after(() => {
  globalThis.fetch = realFetch;
  try { getDatabase()?.close(); } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { requests = 0; setRouterSettings({ ...ALLOW }); });

test('each new shape is a real gap of the historical detector, and is now detected', () => {
  for (const [kind, secret] of Object.entries(FAKE)) {
    assert.equal(containsSecretShape(JSON.stringify(msg(`voici ${secret} merci`))), false, `${kind} was already caught (not a gap)`);
    assert.equal(containsCloudSecretShape(msg(`voici ${secret} merci`)), true, kind);
  }
});

test('the cloud choke point blocks every fake secret before any request, and records the incident without content', async () => {
  const before = getPrivacyViolations(1000).length;
  for (const [kind, secret] of Object.entries(FAKE)) {
    assert.throws(() => guardCloudCall({ messages: msg(`Peux-tu vérifier ${secret} ?`), provider: 'gemini', functionCalled: 'complete' }),
      (e) => e instanceof SecretExposureError && e instanceof PrivacyViolationError && e.isPrivacyViolation === true, kind);
    await assert.rejects(geminiComplete({ apiKey: 'c3c_synthetic', model: 'gemini-2.5-flash', messages: msg(`clé ${secret}`) }), SecretExposureError, kind);
  }
  assert.equal(requests, 0);
  const logged = getPrivacyViolations(1000).slice(0, getPrivacyViolations(1000).length - before);
  assert.equal(logged.length, Object.keys(FAKE).length * 2);
  for (const secret of Object.values(FAKE)) assert.doesNotMatch(JSON.stringify(logged), new RegExp(secret.slice(0, 12).replace(/[-+]/g, '\\$&')));
});

test('the error message never echoes the secret', () => {
  for (const secret of Object.values(FAKE)) {
    try { guardCloudCall({ messages: msg(secret), provider: 'groq', functionCalled: 'complete' }); assert.fail('not blocked'); }
    catch (e) { assert.equal(String(e.message).includes(secret), false); assert.equal(String(e.message).includes(secret.slice(0, 10)), false); }
  }
});

test('ordinary text, public keys and certificates still reach the cloud (no excessive false positives)', async () => {
  for (const text of BENIGN) {
    assert.equal(containsCloudSecretShape(msg(text)), false, text);
    assert.doesNotThrow(() => guardCloudCall({ messages: msg(text), provider: 'gemini', functionCalled: 'complete' }), text);
  }
  await geminiComplete({ apiKey: 'c3c_synthetic', model: 'gemini-2.5-flash', messages: msg(BENIGN[0]) });
  assert.equal(requests, 1, 'the benign request reached the (stubbed) provider');
});

test('order of checks is unchanged: Strict Local and cloud-not-enabled refusals still come first', () => {
  setRouterSettings({ strict_local_mode: true, cloud_enabled: true });
  assert.throws(() => guardCloudCall({ messages: msg(FAKE.huggingface), provider: 'gemini', functionCalled: 'complete' }), (e) => e.decisionCode === 'DENY_STRICT_LOCAL');
  setRouterSettings({ strict_local_mode: false, cloud_enabled: false });
  assert.throws(() => guardCloudCall({ messages: msg(FAKE.huggingface), provider: 'gemini', functionCalled: 'complete' }), (e) => e.decisionCode === 'DENY_CLOUD_NOT_ENABLED');
});

test('historical shapes are still refused by the Root Policy itself (unchanged)', () => {
  const historical = `sk-ant-${fill(30)}`;
  assert.throws(() => guardCloudCall({ messages: msg(historical), provider: 'gemini', functionCalled: 'complete' }), (e) => e.decisionCode === 'DENY_SECRET_EXPOSURE');
});

test('the synthetic self-test mode (simulate) is unchanged: no policy decision, no secret scan, no incident', () => {
  const before = getPrivacyViolations(1000).length;
  assert.doesNotThrow(() => guardCloudCall({ messages: msg(FAKE.gitlab), provider: 'gemini', functionCalled: 'selftest', simulate: true }));
  assert.equal(getPrivacyViolations(1000).length, before);
});
