import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { isPrivateIpv4, tlsJsonRequest } from './src/lib/omega-outbound-network.js';

function lanAddress() {
  for (const values of Object.values(os.networkInterfaces())) {
    for (const value of values ?? []) if (value.family === 'IPv4' && !value.internal && isPrivateIpv4(value.address)) return value.address;
  }
  return null;
}

function certificate(dir, name, sans) {
  const key = path.join(dir, `${name}.key.pem`);
  const cert = path.join(dir, `${name}.cert.pem`);
  const config = path.join(dir, 'openssl.cnf');
  if (!fs.existsSync(config)) fs.writeFileSync(config, '[req]\ndistinguished_name=dn\n[dn]\n', 'utf8');
  execFileSync('openssl', ['req', '-config', config, '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=${sans.join(',')}`, '-keyout', key, '-out', cert],
  { windowsHide: true, stdio: 'ignore' });
  const keyPem = fs.readFileSync(key, 'utf8');
  const certificatePem = fs.readFileSync(cert, 'utf8');
  return { keyPem, certificatePem, fingerprint: new crypto.X509Certificate(certificatePem).fingerprint256 };
}

async function listen(pair, host) {
  const server = https.createServer({ key: pair.keyPem, cert: pair.certificatePem }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  server.listen(0, host);
  await once(server, 'listening');
  return server;
}

test('temporary LAN certificates enforce SAN, exact IP, hostname and pin without bypass', { timeout: 30_000 }, async t => {
  const address = lanAddress();
  if (!address) return t.skip('no RFC1918 IPv4 is configured');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-san-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const valid = certificate(scratch, 'omega-valid', ['DNS:localhost', 'IP:127.0.0.1', `IP:${address}`]);
  const wrong = certificate(scratch, 'omega-wrong', ['DNS:wrong.invalid', 'IP:192.168.254.254']);
  const validX509 = new crypto.X509Certificate(valid.certificatePem);
  assert.equal(validX509.checkIP(address), address);
  assert.equal(validX509.checkIP('192.168.254.254'), undefined);
  assert.equal(validX509.checkHost('localhost'), 'localhost');
  assert.equal(validX509.checkHost('wrong.invalid'), undefined);

  const validServer = await listen(valid, address);
  t.after(() => validServer.close());
  const request = pair => tlsJsonRequest({ host: address, port: validServer.address().port,
    certificatePem: pair.certificatePem, expectedFingerprint: pair.fingerprint,
    requestPath: '/', body: {} });
  assert.equal((await request(valid)).status, 200);
  await assert.rejects(tlsJsonRequest({ host: address, port: validServer.address().port,
    certificatePem: valid.certificatePem, expectedFingerprint: '00'.repeat(32), requestPath: '/', body: {} }),
  /TLS_IDENTITY_MISMATCH/);
  await assert.rejects(request(wrong), /certificate|self-signed|verify|issuer|unable/i);

  const wrongServer = await listen(wrong, address);
  t.after(() => wrongServer.close());
  await assert.rejects(tlsJsonRequest({ host: address, port: wrongServer.address().port,
    certificatePem: wrong.certificatePem, expectedFingerprint: wrong.fingerprint, requestPath: '/', body: {} }),
  /altname|IP address|certificate/i);

  const loopbackServer = await listen(valid, '::');
  t.after(() => loopbackServer.close());
  await assert.rejects(tlsJsonRequest({ host: 'localhost', port: loopbackServer.address().port,
    certificatePem: valid.certificatePem, expectedFingerprint: valid.fingerprint, requestPath: '/', body: {} }),
  /wrong_peer_address|TLS_IDENTITY_MISMATCH/);
});
