import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  canonicalMessage, identityFingerprint, permissionAllowed, requestFields,
  responseFields, signMessage, timestampFresh, verifyMessage,
} from './src/lib/omega-outbound-protocol.js';
import { assertOmegaPrivateDestination, isPrivateIpv4 } from './src/lib/omega-outbound-network.js';

test('OMEGA V2 canonical signatures bind every request field and body hash', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fields = requestFields({ localDeviceId: 'ov2c-a', remoteDeviceId: 'ov2h-b', sessionId: 's',
    requestId: 'r', timestamp: new Date().toISOString(), nonce: 'n', method: 'POST', path: '/fixed',
    bodyBytes: Buffer.from('{}') });
  const signature = signMessage(privateKey, 'OMEGA-V2/CONTROLLER/REQUEST', fields);
  assert.equal(verifyMessage(publicPem, signature, 'OMEGA-V2/CONTROLLER/REQUEST', fields), true);
  for (const key of ['localDeviceId', 'remoteDeviceId', 'sessionId', 'requestId', 'timestamp', 'nonce', 'method', 'path', 'bodyHash']) {
    assert.equal(verifyMessage(publicPem, signature, 'OMEGA-V2/CONTROLLER/REQUEST', { ...fields, [key]: `${fields[key]}x` }), false, key);
  }
  assert.notEqual(canonicalMessage('A', fields).toString(), canonicalMessage('B', fields).toString());
  assert.equal(identityFingerprint(publicPem).length, 64);
});

test('response binding, permission order, timestamp and RFC1918 policy are closed', () => {
  const fields = responseFields({ localDeviceId: 'a', remoteDeviceId: 'b', sessionId: 's', requestId: 'r',
    timestamp: new Date().toISOString(), statusCode: 200, bodyBytes: Buffer.from('{}') });
  assert.equal(fields.bodyHash.length, 64);
  assert.equal(permissionAllowed('VIEW', 'ADMIN'), true);
  assert.equal(permissionAllowed('ADMIN', 'INTERACTIVE'), false);
  assert.equal(permissionAllowed('ROOT', 'ADMIN'), false);
  assert.equal(timestampFresh(new Date().toISOString()), true);
  assert.equal(timestampFresh(new Date(Date.now() - 120_000).toISOString()), false);
  assert.equal(isPrivateIpv4('10.1.2.3'), true);
  assert.equal(isPrivateIpv4('172.31.2.3'), true);
  assert.equal(isPrivateIpv4('192.168.1.2'), true);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
  assert.equal(isPrivateIpv4('127.0.0.1'), false);
});

test('public, unknown-profile and loopback destinations fail closed outside the harness', async () => {
  await assert.rejects(assertOmegaPrivateDestination('8.8.8.8'), /NETWORK_UNAVAILABLE/);
  await assert.rejects(assertOmegaPrivateDestination('127.0.0.1'), /NETWORK_UNAVAILABLE/);
  await assert.rejects(assertOmegaPrivateDestination('192.168.1.8', { profileProbe: async () => 'Public' }), /NETWORK_PROFILE_NOT_PRIVATE/);
  await assert.rejects(assertOmegaPrivateDestination('192.168.1.8', { profileProbe: async () => 'Unknown' }), /NETWORK_PROFILE_NOT_PRIVATE/);
  await assert.doesNotReject(assertOmegaPrivateDestination('192.168.1.8', { profileProbe: async () => 'Private' }));
});
