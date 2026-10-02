// WEB EGRESS GUARD V1 — unit + security + redirect + DNS + rebinding + TLS tests.
// Run: node --test test-web-egress-guard.mjs
//
// No packet is ever sent to a LAN host, a private range or a metadata endpoint: forbidden destinations are
// proven blocked BEFORE any connection. Real sockets are only opened on loopback fixtures started by this file.
import './test-setup.mjs';
import { test, describe, after } from 'node:test';
import dns from 'node:dns';
import net from 'node:net';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  EGRESS_REASONS, EgressDeniedError, classifyAddress, parseIPv4, parseIPv6, createEgressClient,
  validateOutboundUrl, safeFetch, setEgressLogger, installBrowserEgressGuard,
} from './src/lib/web-egress-guard.js';
import { assertSafeUrl } from './src/lib/url-security.js';
import { isPublicAddress as cyberIsPublic } from './src/lib/cyber-policy.js';
import { publicAddress as sherlockIsPublic } from './src/lib/sherlock-policy.js';


// ── network spy: this suite must never resolve a real name or connect to anything but its own loopback fixtures ──────
const spy = { dnsLookups: [], connects: [] };
{
  const realLookup = dns.promises.lookup;
  dns.promises.lookup = (...a) => { spy.dnsLookups.push(String(a[0])); return realLookup.apply(dns.promises, a); };
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    const first = args[0];
    const target = first && typeof first === 'object' && !Array.isArray(first) ? { host: first.host ?? first.path ?? 'localhost', port: first.port, pinned: typeof first.lookup === 'function' } : { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
    spy.connects.push(target);
    return realConnect.apply(this, args);
  };
}
after(() => {
  // A hostname is only acceptable when the socket carries the guard's PINNED lookup (it then connects to a validated address, no real DNS).
  const external = spy.connects.filter(c => !c.pinned && !['127.0.0.1', '127.0.0.2', 'localhost', '::1'].includes(String(c.host)));
  assert.deepEqual(external, [], 'the guard test-suite attempted a non-loopback connection: ' + JSON.stringify(external));
  assert.deepEqual(spy.dnsLookups, [], 'the guard test-suite performed a real DNS lookup');
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

async function startServer(handler, { host = '127.0.0.1', tls = null } = {}) {
  const sockets = new Set();
  const state = { connections: 0, requests: [] };
  const server = tls ? https.createServer(tls, (req, res) => { state.requests.push({ url: req.url, headers: req.headers, servername: req.socket.servername }); handler(req, res, state); })
    : http.createServer((req, res) => { state.requests.push({ url: req.url, headers: req.headers }); handler(req, res, state); });
  server.on('connection', s => { state.connections++; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('secureConnection', () => { /* counted through 'connection' */ });
  server.listen(0, host);
  await once(server, 'listening');
  const port = server.address().port;
  return { server, port, state, close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }) };
}

/** A client whose ONLY relaxation is "127.0.0.1 counts as the fixture's public address" (everything else keeps the real policy). */
function fixtureClient(ports, extra = {}) {
  return createEgressClient({
    ports,
    addressPolicy: info => info.address === '127.0.0.1' || info.public,
    ...extra,
  });
}
const mapTo = (table) => async (host) => { const v = table[host]; if (!v) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return v.map(address => ({ address, family: address.includes(':') ? 6 : 4 })); };
const code = (fn) => async () => { try { await fn(); } catch (e) { return e.code ?? e.name; } return 'NO_ERROR'; };
async function reason(promiseOrFn) { try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (e) { return e?.name === 'AbortError' ? 'AbortError' : (e?.code ?? e?.name); } return 'NO_ERROR'; }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('address parsing', () => {
  test('IPv4 strict parsing', () => {
    assert.deepEqual(parseIPv4('1.2.3.4'), [1, 2, 3, 4]);
    for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.4 ', '', 'a.b.c.d', '127.1']) assert.equal(parseIPv4(bad), null, bad);
  });

  test('IPv6 parsing: compression, dotted tail, invalid forms', () => {
    const eq = (text, hex) => assert.equal(Buffer.from(parseIPv6(text)).toString('hex'), hex, text);
    eq('::', '00'.repeat(16));
    eq('::1', '00'.repeat(15) + '01');
    eq('1::', '0001' + '00'.repeat(14));
    eq('::ffff:1.2.3.4', '00'.repeat(10) + 'ffff01020304');
    eq('::ffff:7f00:1', '00'.repeat(10) + 'ffff7f000001');
    eq('1:2:3:4:5:6:7:8', '0001000200030004000500060007000' + '8');
    eq('1:2:3:4:5:6:1.2.3.4', '000100020003000400050006' + '01020304');
    eq('2001:DB8::1', '20010db8' + '00'.repeat(11) + '01');
    for (const bad of ['1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7', 'fe80::1%eth0', ':::', '1:2:3:4:5:6:7:8:9', '::1.2.3', '', '1.2.3.4']) assert.equal(parseIPv6(bad), null, bad);
  });

  test('IPv6 round-trip fuzz (full form, compressed form, dotted tail) parses to the same 16 bytes', () => {
    const compress = (groups) => {
      let best = { start: -1, len: 0 };
      for (let i = 0; i < 8;) { if (groups[i] !== 0) { i++; continue; } let j = i; while (j < 8 && groups[j] === 0) j++; if (j - i > best.len && j - i >= 2) best = { start: i, len: j - i }; i = j; }
      const hex = groups.map(g => g.toString(16));
      if (best.start < 0) return hex.join(':');
      return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.len).join(':')}`;
    };
    for (let n = 0; n < 500; n++) {
      const bytes = crypto.randomBytes(16);
      if (n % 3 === 0) for (let i = 0; i < 8 + (n % 5); i++) bytes[(i * 3) % 16] = 0; // force zero runs
      const groups = Array.from({ length: 8 }, (_, i) => (bytes[i * 2] << 8) | bytes[i * 2 + 1]);
      const expected = Buffer.from(bytes).toString('hex');
      assert.equal(Buffer.from(parseIPv6(groups.map(g => g.toString(16)).join(':'))).toString('hex'), expected);
      assert.equal(Buffer.from(parseIPv6(compress(groups))).toString('hex'), expected, compress(groups));
      const tail = `${groups.slice(0, 6).map(g => g.toString(16)).join(':')}:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      assert.equal(Buffer.from(parseIPv6(tail)).toString('hex'), expected, tail);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('address classification (IANA special-purpose registries)', () => {
  const blocked = (address, category) => assert.deepEqual([classifyAddress(address).public, classifyAddress(address).category], [false, category], `${address} → ${category}`);
  const open = (address) => assert.equal(classifyAddress(address).public, true, `${address} must be public`);

  test('loopback (IPv4 + IPv6) — every form', () => {
    for (const a of ['127.0.0.1', '127.0.0.2', '127.255.255.255', '127.1.2.3']) blocked(a, 'LOOPBACK');
    blocked('::1', 'LOOPBACK');
  });

  test('ORIGINAL BYPASS + the whole IPv4-embedded class', () => {
    blocked('::ffff:127.0.0.1', 'LOOPBACK');
    blocked('::ffff:7f00:1', 'LOOPBACK');           // canonical form the URL parser emits
    blocked('::FFFF:127.0.0.1', 'LOOPBACK');
    blocked('0:0:0:0:0:ffff:7f00:0001', 'LOOPBACK');
    blocked('::ffff:10.1.2.3', 'PRIVATE');
    blocked('::ffff:192.168.0.1', 'PRIVATE');
    blocked('::ffff:172.16.0.1', 'PRIVATE');
    blocked('::ffff:169.254.1.1', 'LINK_LOCAL');
    blocked('::ffff:169.254.169.254', 'METADATA');
    blocked('::ffff:0.0.0.0', 'UNSPECIFIED');
    blocked('::ffff:224.0.0.1', 'MULTICAST');
    blocked('::127.0.0.1', 'LOOPBACK');             // IPv4-compatible (deprecated)
    blocked('::10.0.0.1', 'PRIVATE');
    blocked('::8.8.8.8', 'RESERVED');                // compatible form is never public
    blocked('64:ff9b::7f00:1', 'LOOPBACK');          // NAT64 → embedded loopback
    blocked('64:ff9b::a00:1', 'PRIVATE');
    blocked('64:ff9b::808:808', 'RESERVED');         // NAT64 with a public IPv4 is still refused
    blocked('64:ff9b:1::1', 'RESERVED');
    blocked('2002:7f00:1::', 'LOOPBACK');            // 6to4 embedding 127.0.0.1
    blocked('2002:a00:1::', 'PRIVATE');
    blocked('2002:808:808::', 'RESERVED');
    blocked('::ffff:8.8.8.8', 'RESERVED');          // mapped form of a PUBLIC IPv4 is refused too (no legitimate use; certified modules refuse it)
    assert.equal(classifyAddress('::ffff:8.8.8.8').mapped, true);
  });

  test('RFC1918 / CGNAT boundaries: just before, start, end, just after', () => {
    const cases = [
      ['9.255.255.255', 'PUBLIC'], ['10.0.0.0', 'PRIVATE'], ['10.255.255.255', 'PRIVATE'], ['11.0.0.0', 'PUBLIC'],
      ['172.15.255.255', 'PUBLIC'], ['172.16.0.0', 'PRIVATE'], ['172.31.255.255', 'PRIVATE'], ['172.32.0.0', 'PUBLIC'],
      ['192.167.255.255', 'PUBLIC'], ['192.168.0.0', 'PRIVATE'], ['192.168.255.255', 'PRIVATE'], ['192.169.0.0', 'PUBLIC'],
      ['100.63.255.255', 'PUBLIC'], ['100.64.0.0', 'PRIVATE'], ['100.127.255.255', 'PRIVATE'], ['100.128.0.0', 'PUBLIC'],
      ['169.253.255.255', 'PUBLIC'], ['169.254.0.0', 'LINK_LOCAL'], ['169.254.255.255', 'LINK_LOCAL'], ['169.255.0.0', 'PUBLIC'],
      ['198.17.255.255', 'PUBLIC'], ['198.18.0.0', 'RESERVED'], ['198.19.255.255', 'RESERVED'], ['198.20.0.0', 'PUBLIC'],
      ['223.255.255.255', 'PUBLIC'], ['224.0.0.0', 'MULTICAST'], ['239.255.255.255', 'MULTICAST'], ['240.0.0.0', 'RESERVED'], ['255.255.255.255', 'RESERVED'],
      ['0.0.0.0', 'UNSPECIFIED'], ['0.0.0.1', 'RESERVED'], ['0.255.255.255', 'RESERVED'], ['1.0.0.0', 'PUBLIC'],
      ['192.0.0.0', 'RESERVED'], ['192.0.0.255', 'RESERVED'], ['192.0.1.0', 'PUBLIC'], ['192.0.2.1', 'RESERVED'], ['198.51.100.1', 'RESERVED'], ['203.0.113.1', 'RESERVED'], ['192.88.99.1', 'RESERVED'],
      ['8.8.8.8', 'PUBLIC'], ['93.184.216.34', 'PUBLIC'], ['1.1.1.1', 'PUBLIC'],
    ];
    for (const [address, category] of cases) assert.equal(classifyAddress(address).category, category, address);
  });

  test('cloud metadata endpoints', () => {
    for (const a of ['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192', '168.63.129.16', 'fd00:ec2::254']) blocked(a, 'METADATA');
  });

  test('IPv6 special-use + allow-list (only global unicast 2000::/3 minus special blocks is public)', () => {
    blocked('::', 'UNSPECIFIED');
    for (const a of ['fe80::1', 'febf::1']) blocked(a, 'LINK_LOCAL');
    for (const a of ['fc00::1', 'fd12:3456::1', 'fdff::1', 'fec0::1']) blocked(a, 'PRIVATE');
    for (const a of ['ff00::1', 'ff02::1', 'ff0e::1']) blocked(a, 'MULTICAST');
    for (const a of ['2001::1', '2001:1ff::1', '2001:db8::1', '3fff::1', '3fff:fff::1', '100::1', '5f00::1', '1::1', '4000::1', '7000::1', 'e000::1']) blocked(a, 'RESERVED');
    for (const a of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4007:80b::200e', '2001:200::1', '3ffe::1', '2620:4f:8000::1']) open(a);
    assert.equal(classifyAddress('2001:200::1').public, true, '2001:200::/23 is outside 2001::/23');
  });

  test('unknown / unparseable ⇒ fail closed', () => {
    for (const a of ['', 'not-an-ip', '1.2.3', '12345::', '::g', null, undefined, '1.2.3.4.5']) {
      const info = classifyAddress(a);
      assert.equal(info.public, false, String(a));
      assert.equal(info.unknown, true, String(a));
    }
  });

  test('PARITY: the central classifier is never weaker than the certified Sherlock / Cyber Audit implementations', () => {
    const samples = [];
    for (let a = 0; a < 256; a += 1) for (const b of [0, 1, 15, 16, 31, 32, 63, 64, 100, 127, 128, 168, 169, 170, 253, 254, 255]) samples.push(`${a}.${b}.1.1`, `${a}.${b}.0.0`, `${a}.${b}.255.255`);
    for (const g of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '2001:db8::1', '2002::1', '3fff::1', '2606:4700::1', '2a00::1', '::ffff:1.2.3.4', '64:ff9b::1', '2001::1', '2001:4860::1']) samples.push(g);
    for (const ip of samples) {
      const ours = classifyAddress(ip).public;
      for (const [name, legacy] of [['cyber-policy', cyberIsPublic], ['sherlock-policy', sherlockIsPublic]]) {
        if (legacy(ip)) continue;
        // Justified differences (the legacy checks over-block real public space): 192.0.0.0/16 minus 192.0.0.0/24 + 192.0.2.0/24
        // (e.g. 192.0.43.8 = iana.org) and the whole 2001::/16 (e.g. 2001:4860::/32 = Google DNS) — IANA registries are authoritative.
        if (/^192\.0\.(?!0\.|2\.)/.test(ip) || /^2001:/.test(ip)) continue;
        assert.equal(ours, false, `${name} blocks ${ip} but the central guard allows it`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('static URL validation (parse → normalize → scheme → userinfo → host → port)', () => {
  const r = (url, opts) => { try { validateOutboundUrl(url, opts); return 'ALLOWED'; } catch (e) { return e.code; } };

  test('public URLs pass', () => {
    for (const u of ['https://example.com/', 'https://example.com/path?q=test', 'http://example.com/', 'https://sub.example.co.uk:443/x#frag', 'http://example.com:80/', 'https://EXAMPLE.com/', 'https://localhost.example.com/', 'https://fdic.gov/', 'https://fd.example.com/']) assert.equal(r(u), 'ALLOWED', u);
  });

  test('loopback, in every representation the URL parser accepts', () => {
    for (const u of ['http://127.0.0.1/', 'http://127.0.0.2/', 'http://127.255.255.254/', 'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.0.0.1./']) assert.equal(r(u), EGRESS_REASONS.LOOPBACK, u);
  });

  test('REGRESSION: IPv4-mapped IPv6 in URLs', () => {
    assert.equal(r('http://[::ffff:127.0.0.1]/'), EGRESS_REASONS.LOOPBACK);
    assert.equal(r('http://[::ffff:7f00:1]/'), EGRESS_REASONS.LOOPBACK);
    assert.equal(r('http://[0:0:0:0:0:ffff:127.0.0.1]/'), EGRESS_REASONS.LOOPBACK);
    assert.equal(r('http://[::FFFF:127.0.0.1]/'), EGRESS_REASONS.LOOPBACK);
    assert.equal(r('http://[::ffff:10.0.0.1]/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://[::ffff:192.168.1.1]/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://[::ffff:169.254.1.1]/'), EGRESS_REASONS.LINK_LOCAL);
    assert.equal(r('http://[::ffff:169.254.169.254]/'), EGRESS_REASONS.METADATA);
    assert.equal(r('https://[::ffff:127.0.0.1]:443/'), EGRESS_REASONS.LOOPBACK);
  });

  test('private, link-local, metadata, unspecified, multicast, reserved', () => {
    assert.equal(r('http://10.0.0.1/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://172.16.5.5/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://192.168.1.1/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://100.64.0.1/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://[fd00::1]/'), EGRESS_REASONS.PRIVATE);
    assert.equal(r('http://169.254.1.1/'), EGRESS_REASONS.LINK_LOCAL);
    assert.equal(r('http://[fe80::1]/'), EGRESS_REASONS.LINK_LOCAL);
    assert.equal(r('http://169.254.169.254/'), EGRESS_REASONS.METADATA);
    assert.equal(r('http://[fd00:ec2::254]/'), EGRESS_REASONS.METADATA);
    assert.equal(r('http://0.0.0.0/'), EGRESS_REASONS.UNSPECIFIED);
    assert.equal(r('http://[::]/'), EGRESS_REASONS.UNSPECIFIED);
    assert.equal(r('http://224.0.0.1/'), EGRESS_REASONS.MULTICAST);
    assert.equal(r('http://[ff02::1]/'), EGRESS_REASONS.MULTICAST);
    assert.equal(r('http://240.0.0.1/'), EGRESS_REASONS.RESERVED);
    assert.equal(r('http://255.255.255.255/'), EGRESS_REASONS.RESERVED);
    assert.equal(r('http://[2001:db8::1]/'), EGRESS_REASONS.RESERVED);
    assert.equal(r('http://[64:ff9b::7f00:1]/'), EGRESS_REASONS.LOOPBACK);
    assert.equal(r('http://[2002:7f00:1::]/'), EGRESS_REASONS.LOOPBACK);
  });

  test('local names, trailing dot, case, single-label and reserved suffixes', () => {
    for (const u of ['http://localhost/', 'http://LOCALHOST/', 'http://localhost./', 'http://foo.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://intranet/', 'http://nas.lan/', 'http://router.home.arpa/', 'http://host.localdomain/', 'http://singlelabel/']) assert.equal(r(u), EGRESS_REASONS.LOCAL_NAME, u);
    assert.equal(r('https://example.com./'), 'ALLOWED', 'a single trailing dot on a public name is normalised away');
    assert.equal(r('https://example.com../'), EGRESS_REASONS.INVALID_URL);
  });

  test('userinfo confusion: the parser decides the real host', () => {
    assert.equal(r('http://allowed.example@127.0.0.1/'), EGRESS_REASONS.USERINFO);
    assert.equal(r('http://127.0.0.1@example.com/'), EGRESS_REASONS.USERINFO);
    assert.equal(r('http://user:pw@example.com/'), EGRESS_REASONS.USERINFO);
    assert.equal(r('http://example.com@127.0.0.1:80@evil.com/'), EGRESS_REASONS.USERINFO);
    assert.equal(r('https://example.com:pw@[::1]/'), EGRESS_REASONS.USERINFO);
    // These LOOK like a userinfo trick but the true hostname is the PUBLIC one — the parser, not a regex, decides.
    assert.equal(r('http://example.com#@127.0.0.1/'), 'ALLOWED');
    assert.equal(r('http://example.com?@127.0.0.1/'), 'ALLOWED');
    assert.equal(r('http://example.com/@127.0.0.1/'), 'ALLOWED');
    assert.equal(r('http://localhost.example.com/'), 'ALLOWED');
    assert.equal(r('http://127.0.0.1\@example.com/'), EGRESS_REASONS.USERINFO, 'whatever the parser makes of the backslash, a userinfo form is refused');
  });

  test('schemes: explicit allow-list, not a blacklist', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,hi', 'javascript:alert(1)', 'gopher://example.com/', 'ws://example.com/', 'wss://example.com/', 'blob:https://example.com/x', 'mailto:a@b.c', 'ldap://example.com/', 'dict://example.com/', 'tftp://example.com/', 'about:blank', 'chrome://settings', 'view-source:https://example.com/']) assert.equal(r(u), EGRESS_REASONS.SCHEME, u);
    assert.equal(r('http://example.com/', { allowHttp: false }), EGRESS_REASONS.SCHEME);
    assert.equal(r('HTTPS://example.com/'), 'ALLOWED');
  });

  test('ports: standard ports only', () => {
    assert.equal(r('https://example.com:443/'), 'ALLOWED');
    assert.equal(r('http://example.com:80/'), 'ALLOWED');
    for (const u of ['https://example.com:8443/', 'http://example.com:6379/', 'http://example.com:22/', 'http://example.com:3001/', 'http://example.com:8080/', 'http://example.com:11434/']) assert.equal(r(u), EGRESS_REASONS.PORT, u);
    assert.equal(r('http://example.com:99999/'), EGRESS_REASONS.INVALID_URL);
    assert.equal(r('http://example.com:-1/'), EGRESS_REASONS.INVALID_URL);
    assert.equal(r('http://example.com:abc/'), EGRESS_REASONS.INVALID_URL);
  });

  test('malformed input fails closed', () => {
    for (const u of ['http://', 'http:///', 'http://[::1', 'http://[zzzz]/', 'http://exa mple.com/', '//example.com/', '/relative', 'example.com', 'http://%00/', 'http://.example.com/', 'http://a..b/']) assert.equal(r(u), EGRESS_REASONS.INVALID_URL, u);
    for (const u of ['', ' ', 'http://', 'http://[::1', 'example.com', '/relative']) assert.equal(r(u), EGRESS_REASONS.INVALID_URL, JSON.stringify(u));
    for (const bad of [null, undefined, 42, {}, [], true]) assert.equal(r(bad), EGRESS_REASONS.INVALID_URL, String(bad));
    assert.equal(r(`https://example.com/${'a'.repeat(9000)}`), EGRESS_REASONS.INVALID_URL, 'oversized URL');
  });

  test('legacy assertSafeUrl keeps its signature and messages and is now backed by the central classifier', () => {
    assert.throws(() => assertSafeUrl('http://[::ffff:127.0.0.1]/'), e => e instanceof EgressDeniedError && e.code === 'BLOCKED_LOOPBACK' && /adresses internes/.test(e.message));
    assert.throws(() => assertSafeUrl('not a url'), /URL invalide/);
    assert.throws(() => assertSafeUrl('ftp://example.com/'), /Protocole non autorisé/);
    assert.doesNotThrow(() => assertSafeUrl('https://fdic.gov/'));
    assert.doesNotThrow(() => assertSafeUrl('https://example.com/a?b=c'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DNS resolution and validation of ALL resolved addresses', () => {
  const client = (table, extra = {}) => createEgressClient({ lookup: mapTo(table), ...extra });
  const resolve = (c, url) => c.resolveOutboundTarget(c.validateOutboundUrl(url));

  test('public hostname → allowed; every address is returned for the pinned connection', async () => {
    const c = client({ 'public.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
    const t = await resolve(c, 'https://public.example/');
    assert.equal(t.addresses.length, 2);
  });

  test('hostname resolving to a private/loopback/link-local/metadata address → BLOCKED_DNS_PRIVATE', async () => {
    const c = client({ 'a.example': ['127.0.0.1'], 'b.example': ['10.0.0.5'], 'c.example': ['169.254.169.254'], 'd.example': ['::1'], 'e.example': ['::ffff:127.0.0.1'], 'f.example': ['fd00::1'], 'g.example': ['0.0.0.0'], 'h.example': ['100.64.1.1'] });
    for (const h of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) assert.equal(await reason(() => resolve(c, `https://${h}.example/`)), EGRESS_REASONS.DNS_PRIVATE, h);
  });

  test('MIXED public + private answers are refused, in either order (never "first good IP")', async () => {
    const c = client({ 'mixed.example': ['93.184.216.34', '127.0.0.1'], 'mixed2.example': ['127.0.0.1', '93.184.216.34'], 'mixed3.example': ['93.184.216.34', '2606:2800:220:1::1', '::ffff:10.0.0.1'] });
    for (const h of ['mixed', 'mixed2', 'mixed3']) assert.equal(await reason(() => resolve(c, `https://${h}.example/`)), EGRESS_REASONS.DNS_PRIVATE, h);
  });

  test('DNS failure, empty answer, malformed answer, timeout ⇒ fail closed', async () => {
    assert.equal(await reason(() => resolve(client({}), 'https://nxdomain.example/')), EGRESS_REASONS.DNS_FAILURE);
    assert.equal(await reason(() => resolve(client({ 'empty.example': [] }), 'https://empty.example/')), EGRESS_REASONS.DNS_FAILURE);
    const weird = createEgressClient({ lookup: async () => [{ address: 'garbage', family: 4 }] });
    assert.equal(await reason(() => weird.resolveOutboundTarget(weird.validateOutboundUrl('https://weird.example/'))), EGRESS_REASONS.DNS_PRIVATE);
    const notArray = createEgressClient({ lookup: async () => ({ address: '8.8.8.8' }) });
    assert.equal(await reason(() => notArray.resolveOutboundTarget(notArray.validateOutboundUrl('https://x.example/'))), EGRESS_REASONS.DNS_FAILURE);
    const slow = createEgressClient({ dnsTimeoutMs: 50, lookup: () => new Promise(() => {}) });
    assert.equal(await reason(() => slow.resolveOutboundTarget(slow.validateOutboundUrl('https://slow.example/'))), EGRESS_REASONS.DNS_FAILURE);
    const throwsSync = createEgressClient({ lookup: () => { throw new Error('boom'); } });
    assert.equal(await reason(() => throwsSync.resolveOutboundTarget(throwsSync.validateOutboundUrl('https://boom.example/'))), EGRESS_REASONS.DNS_FAILURE);
  });

  test('IP literals are classified without any DNS query', async () => {
    let calls = 0;
    const c = createEgressClient({ lookup: async () => { calls++; return []; } });
    assert.equal(await reason(() => c.resolveOutboundTarget(c.validateOutboundUrl('http://[::ffff:127.0.0.1]/'))), EGRESS_REASONS.LOOPBACK);
    const ok = await c.resolveOutboundTarget(c.validateOutboundUrl('https://93.184.216.34/'));
    assert.deepEqual(ok.addresses, [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(calls, 0);
  });

  test('safeFetch refuses forbidden targets and never even calls a connection transport', async () => {
    let transportCalls = 0;
    const c = createEgressClient({ lookup: mapTo({ 'evil.example': ['93.184.216.34', '127.0.0.1'] }), transport: () => { transportCalls++; throw new Error('must not connect'); } });
    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://127.0.0.1/', 'http://evil.example/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://example.com:8080/']) {
      assert.ok(['BLOCKED_LOOPBACK', 'BLOCKED_DNS_PRIVATE', 'BLOCKED_PRIVATE', 'BLOCKED_METADATA', 'BLOCKED_SCHEME', 'BLOCKED_USERINFO', 'BLOCKED_PORT'].includes(await reason(() => c.safeFetch(url))), url);
    }
    assert.equal(transportCalls, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('real loopback fixtures: connection, redirects, limits (no packet leaves the machine)', () => {
  test('direct fetch works through the pinned connection (Host header keeps the hostname) and returns a standard Response', async () => {
    const s = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'x-test': 'yes' }); res.end('hello'); });
    try {
      const c = fixtureClient([s.port], { lookup: mapTo({ 'friendly.test': ['127.0.0.1'] }) });
      const res = await c.safeFetch(`http://friendly.test:${s.port}/a?b=1`);
      assert.equal(res.status, 200); assert.equal(res.ok, true);
      assert.equal(await res.text(), 'hello');
      assert.equal(res.headers.get('x-test'), 'yes');
      assert.equal(res.redirected, false);
      assert.equal(res.url, `http://friendly.test:${s.port}/a?b=1`);
      assert.equal(s.state.requests[0].headers.host, `friendly.test:${s.port}`);
      assert.equal(s.state.requests[0].url, '/a?b=1');
    } finally { await s.close(); }
  });

  test('HEAD works, POST/PUT are refused', async () => {
    const s = await startServer((req, res) => { res.writeHead(200, { 'content-length': '5' }); res.end(req.method === 'HEAD' ? undefined : 'hello'); });
    try {
      const c = fixtureClient([s.port]);
      const head = await c.safeFetch(`http://127.0.0.1:${s.port}/`, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'CONNECT']) assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${s.port}/`, { method })), EGRESS_REASONS.METHOD, method);
    } finally { await s.close(); }
  });

  test('FORBIDDEN TARGET RECEIVES ZERO CONNECTIONS — direct loopback, mapped loopback, second loopback address', async () => {
    const target = await startServer((_q, res) => { res.end('secret-internal'); }, { host: '127.0.0.1' });
    let other = null;
    try { other = await startServer((_q, res) => { res.end('secret-internal-2'); }, { host: '127.0.0.2' }); } catch { /* 127.0.0.2 unavailable on this host */ }
    try {
      // Strict address policy (production rules); only the PORT policy is opened so the address check is what is exercised.
      const strict = createEgressClient({ ports: [target.port, other?.port].filter(Boolean) });
      assert.equal(await reason(() => strict.safeFetch(`http://127.0.0.1:${target.port}/`)), EGRESS_REASONS.LOOPBACK);
      assert.equal(await reason(() => strict.safeFetch(`http://[::ffff:127.0.0.1]:${target.port}/`)), EGRESS_REASONS.LOOPBACK);
      assert.equal(await reason(() => strict.safeFetch(`http://[::ffff:7f00:1]:${target.port}/`)), EGRESS_REASONS.LOOPBACK);
      assert.equal(await reason(() => strict.safeFetch(`http://localhost:${target.port}/`)), EGRESS_REASONS.LOCAL_NAME);
      assert.equal(await reason(() => strict.safeFetch(`http://2130706433:${target.port}/`)), EGRESS_REASONS.LOOPBACK);
      assert.equal(target.state.connections, 0, 'target received a connection from a forbidden request');
      if (other) { assert.equal(await reason(() => strict.safeFetch(`http://127.0.0.2:${other.port}/`)), EGRESS_REASONS.LOOPBACK); assert.equal(other.state.connections, 0); }
      // Default production client: the loopback target is also unreachable (port policy first) — still zero connections.
      assert.equal(await reason(() => safeFetch(`http://127.0.0.1:${target.port}/`)), EGRESS_REASONS.LOOPBACK);
      assert.equal(target.state.connections, 0);
    } finally { await target.close(); await other?.close(); }
  });

  describe('redirects are followed manually and EVERY hop is revalidated', () => {
    async function withRedirectFixture(fn) {
      let forbidden = null;
      try { forbidden = await startServer((_q, res) => { res.end('INTERNAL'); }, { host: '127.0.0.2' }); } catch { /* optional */ }
      const hops = [];
      const origin = await startServer((req, res, state) => {
        const u = new URL(req.url, 'http://x');
        const send = (status, location) => { res.writeHead(status, { location }); res.end(); };
        hops.push(u.pathname);
        switch (u.pathname) {
          case '/final': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('FINAL');
          case '/to-final': return send(302, '/final');
          case '/to-final-abs': return send(301, `http://ok.test:${origin.port}/final`);
          case '/chain': return send(307, '/to-final');
          case '/to-loopback2': return send(302, `http://127.0.0.2:${forbidden?.port ?? 9}/`);
          case '/to-mapped': return send(302, `http://[::ffff:127.0.0.1]:${origin.port}/final`);
          case '/to-private': return send(302, 'http://10.0.0.5/');
          case '/to-private-v6': return send(302, 'http://[fd00::5]/');
          case '/to-link-local': return send(302, 'http://169.254.1.1/');
          case '/to-metadata': return send(302, 'http://169.254.169.254/latest/meta-data/');
          case '/to-metadata-mapped': return send(302, 'http://[::ffff:a9fe:a9fe]/');
          case '/to-file': return send(302, 'file:///etc/passwd');
          case '/to-ftp': return send(302, 'ftp://example.com/x');
          case '/to-data': return send(302, 'data:text/html,hi');
          case '/to-javascript': return send(302, 'javascript:alert(1)');
          case '/to-userinfo': return send(302, `http://user:pw@ok.test:${origin.port}/final`);
          case '/to-evil-dns': return send(302, `http://evil.test:${origin.port}/final`);
          case '/to-port': return send(302, 'http://ok.test:8080/');
          case '/to-localname': return send(302, 'http://localhost/');
          case '/to-malformed': return send(302, 'http://[bad/');
          case '/to-empty-host': return send(302, 'http:///x');
          case '/ping': return send(302, '/pong');
          case '/pong': return send(302, '/ping');
          case '/self': return send(302, '/self');
          case '/endless': return send(302, `/endless?n=${Number(u.searchParams.get('n') ?? 0) + 1}`);
          case '/two-step-private': return send(302, '/to-private');
          case '/no-location': res.writeHead(302); return res.end('no location');
          case '/dir/rel': return send(302, '../final');
          default: res.writeHead(404); return res.end('nope');
        }
      });
      const ports = [origin.port, forbidden?.port].filter(Boolean);
      const c = fixtureClient(ports, { lookup: mapTo({ 'ok.test': ['127.0.0.1'], 'evil.test': ['93.184.216.34', '127.0.0.2'] }) });
      try { await fn({ c, origin, forbidden, hops }); } finally { await origin.close(); await forbidden?.close(); }
    }

    test('PUBLIC → PUBLIC is allowed (relative, absolute, chained) and reports redirected=true', async () => {
      await withRedirectFixture(async ({ c, origin }) => {
        for (const p of ['/to-final', '/to-final-abs', '/chain', '/dir/rel']) {
          const res = await c.safeFetch(`http://127.0.0.1:${origin.port}${p}`);
          assert.equal(await res.text(), 'FINAL', p); assert.equal(res.redirected, true, p);
        }
        const direct = await c.safeFetch(`http://127.0.0.1:${origin.port}/final`);
        assert.equal(direct.redirected, false); await direct.text();
      });
    });

    test('PUBLIC → LOOPBACK / mapped loopback / PRIVATE / LINK-LOCAL / METADATA / forbidden scheme / userinfo / port / local name are DENIED', async () => {
      await withRedirectFixture(async ({ c, origin, forbidden }) => {
        const expectations = [
          ['/to-loopback2', EGRESS_REASONS.LOOPBACK], ['/to-mapped', EGRESS_REASONS.LOOPBACK], ['/to-private', EGRESS_REASONS.PRIVATE], ['/to-private-v6', EGRESS_REASONS.PRIVATE],
          ['/to-link-local', EGRESS_REASONS.LINK_LOCAL], ['/to-metadata', EGRESS_REASONS.METADATA], ['/to-metadata-mapped', EGRESS_REASONS.METADATA],
          ['/to-file', EGRESS_REASONS.SCHEME], ['/to-ftp', EGRESS_REASONS.SCHEME], ['/to-data', EGRESS_REASONS.SCHEME], ['/to-javascript', EGRESS_REASONS.SCHEME],
          ['/to-userinfo', EGRESS_REASONS.USERINFO], ['/to-evil-dns', EGRESS_REASONS.DNS_PRIVATE], ['/to-port', EGRESS_REASONS.PORT], ['/to-localname', EGRESS_REASONS.LOCAL_NAME],
          ['/to-malformed', EGRESS_REASONS.REDIRECT], ['/to-empty-host', EGRESS_REASONS.LOCAL_NAME], ['/two-step-private', EGRESS_REASONS.PRIVATE],
        ];
        for (const [p, expected] of expectations) assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}${p}`)), expected, p);
        if (forbidden) assert.equal(forbidden.state.connections, 0, 'a redirect reached the forbidden target');
      });
    });

    test('PUBLIC → PUBLIC → PRIVATE: denied at the second hop; the first hops were real requests', async () => {
      await withRedirectFixture(async ({ c, origin, hops }) => {
        hops.length = 0;
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/two-step-private`)), EGRESS_REASONS.PRIVATE);
        assert.deepEqual(hops, ['/two-step-private', '/to-private']);
      });
    });

    test('loops and unbounded chains are cut: self, ping-pong, endless distinct URLs (maxRedirects), maxRedirects=0', async () => {
      await withRedirectFixture(async ({ c, origin, hops }) => {
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/self`)), EGRESS_REASONS.REDIRECT_LOOP);
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/ping`)), EGRESS_REASONS.REDIRECT_LOOP);
        hops.length = 0;
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/endless`, { maxRedirects: 3 })), EGRESS_REASONS.TOO_MANY_REDIRECTS);
        assert.equal(hops.length, 4, 'exactly maxRedirects+1 requests');
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/endless`)), EGRESS_REASONS.TOO_MANY_REDIRECTS, 'default limit (5)');
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${origin.port}/to-final`, { maxRedirects: 0 })), EGRESS_REASONS.TOO_MANY_REDIRECTS);
      });
    });

    test('a 3xx without Location is returned as an ordinary response (nothing to follow)', async () => {
      await withRedirectFixture(async ({ c, origin }) => {
        const res = await c.safeFetch(`http://127.0.0.1:${origin.port}/no-location`);
        assert.equal(res.status, 302); await res.text();
      });
    });

    test('Authorization / Cookie are dropped on a cross-origin redirect and kept on a same-origin one', async () => {
      const seen = [];
      const b = await startServer((req, res) => { seen.push(req.headers); res.end('B'); });
      const a = await startServer((req, res) => {
        if (req.url === '/same') { res.writeHead(302, { location: '/same-target' }); return res.end(); }
        if (req.url === '/same-target') { seen.push({ ...req.headers, __same: true }); return res.end('A2'); }
        res.writeHead(302, { location: `http://other.test:${b.port}/` }); res.end();
      });
      try {
        const c = fixtureClient([a.port, b.port], { lookup: mapTo({ 'other.test': ['127.0.0.1'] }) });
        await (await c.safeFetch(`http://127.0.0.1:${a.port}/cross`, { headers: { Authorization: 'Bearer TOPSECRET', Cookie: 'sid=1', 'X-Keep': 'k' } })).text();
        const cross = seen.find(h => !h.__same);
        assert.equal(cross.authorization, undefined); assert.equal(cross.cookie, undefined); assert.equal(cross['x-keep'], 'k');
        await (await c.safeFetch(`http://127.0.0.1:${a.port}/same`, { headers: { Authorization: 'Bearer TOPSECRET' } })).text();
        assert.equal(seen.find(h => h.__same).authorization, 'Bearer TOPSECRET');
      } finally { await a.close(); await b.close(); }
    });
  });

  describe('response limits', () => {
    test('declared Content-Length above the cap is refused before the body is read', async () => {
      const s = await startServer((_q, res) => { res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) }); res.write('x'); setTimeout(() => res.destroy(), 500); });
      try {
        const c = fixtureClient([s.port]);
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${s.port}/`, { maxBytes: 1024 })), EGRESS_REASONS.RESPONSE_TOO_LARGE);
      } finally { await s.close(); }
    });

    test('chunked body without Content-Length is cut when it crosses the cap (streaming), never buffered whole', async () => {
      const s = await startServer((_q, res) => { res.writeHead(200); const t = setInterval(() => res.write(Buffer.alloc(16 * 1024, 65)), 1); res.on('close', () => clearInterval(t)); });
      try {
        const c = fixtureClient([s.port]);
        const res = await c.safeFetch(`http://127.0.0.1:${s.port}/`, { maxBytes: 100 * 1024 });
        assert.equal(await reason(() => res.arrayBuffer()), EGRESS_REASONS.RESPONSE_TOO_LARGE);
      } finally { await s.close(); }
    });

    test('exactly maxBytes is allowed, maxBytes+1 is not', async () => {
      const s = await startServer((req, res) => { const n = Number(new URL(req.url, 'http://x').searchParams.get('n')); res.writeHead(200); res.end(Buffer.alloc(n, 1)); });
      try {
        const c = fixtureClient([s.port]);
        assert.equal((await (await c.safeFetch(`http://127.0.0.1:${s.port}/?n=1000`, { maxBytes: 1000 })).arrayBuffer()).byteLength, 1000);
        const over = await c.safeFetch(`http://127.0.0.1:${s.port}/?n=1001`, { maxBytes: 1000 }).catch(e => e);
        assert.equal(over.code ?? await reason(() => over.arrayBuffer()), EGRESS_REASONS.RESPONSE_TOO_LARGE);
      } finally { await s.close(); }
    });

    test('DECOMPRESSION BOMB: a tiny gzip that inflates beyond the cap is cut on the DECODED size', async () => {
      const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0)); // ~64 KiB compressed, 64 MiB decoded
      assert.ok(bomb.length < 200 * 1024);
      const s = await startServer((_q, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(bomb); });
      try {
        const c = fixtureClient([s.port]);
        const res = await c.safeFetch(`http://127.0.0.1:${s.port}/`, { maxBytes: 1024 * 1024 });
        assert.equal(await reason(() => res.arrayBuffer()), EGRESS_REASONS.RESPONSE_TOO_LARGE);
      } finally { await s.close(); }
    });

    test('gzip / deflate / br bodies are decoded transparently; unknown encodings are refused', async () => {
      const payload = Buffer.from('compressible '.repeat(200));
      const s = await startServer((req, res) => {
        const enc = new URL(req.url, 'http://x').searchParams.get('e');
        const body = enc === 'gzip' ? zlib.gzipSync(payload) : enc === 'deflate' ? zlib.deflateSync(payload) : enc === 'br' ? zlib.brotliCompressSync(payload) : payload;
        res.writeHead(200, { 'content-encoding': enc }); res.end(body);
      });
      try {
        const c = fixtureClient([s.port]);
        for (const e of ['gzip', 'deflate', 'br']) { const res = await c.safeFetch(`http://127.0.0.1:${s.port}/?e=${e}`); assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), payload), 0, e); assert.equal(res.headers.get('content-encoding'), null); }
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${s.port}/?e=zstd`)), EGRESS_REASONS.ENCODING);
      } finally { await s.close(); }
    });

    test('timeouts: silent server (headers), stalled body (idle), total deadline; AbortSignal', async () => {
      const silent = await startServer(() => { /* never answers */ });
      const stall = await startServer((_q, res) => { res.writeHead(200); res.write('start'); /* then nothing */ });
      const drip = await startServer((_q, res) => { res.writeHead(200); const t = setInterval(() => res.write('x'), 20); res.on('close', () => clearInterval(t)); });
      try {
        const c = fixtureClient([silent.port, stall.port, drip.port]);
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${silent.port}/`, { timeoutMs: 150 })), 'EGRESS_TIMEOUT');
        const res = await c.safeFetch(`http://127.0.0.1:${stall.port}/`, { idleTimeoutMs: 150 });
        assert.equal(await reason(() => res.text()), 'EGRESS_TIMEOUT');
        const d = await c.safeFetch(`http://127.0.0.1:${drip.port}/`, { totalTimeoutMs: 200, maxBytes: 1e9 });
        assert.equal(await reason(() => d.text()), 'EGRESS_TIMEOUT');
        const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 50);
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${silent.port}/`, { signal: ctrl.signal, timeoutMs: 5000 })), 'AbortError');
        assert.equal(await reason(() => c.safeFetch(`http://127.0.0.1:${silent.port}/`, { signal: AbortSignal.abort() })), 'AbortError');
        const ctrl2 = new AbortController();
        const body = await c.safeFetch(`http://127.0.0.1:${drip.port}/`, { signal: ctrl2.signal, maxBytes: 1e9 });
        setTimeout(() => ctrl2.abort(), 60);
        assert.equal(await reason(() => body.text()), 'AbortError');
      } finally { await silent.close(); await stall.close(); await drip.close(); }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DNS rebinding / TOCTOU: the connection uses the address that was VALIDATED', () => {
  test('resolver is consulted ONCE per hop and the socket is pinned to the validated address even if DNS then answers differently', async () => {
    const s = await startServer((_q, res) => { res.end('from-validated-address'); });
    let lookups = 0;
    const c = createEgressClient({
      ports: [s.port],
      addressPolicy: info => info.address === '127.0.0.1' || info.public,
      lookup: async () => { lookups++; return lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]; },
    });
    try {
      const res = await c.safeFetch(`http://rebind.test:${s.port}/`);
      assert.equal(await res.text(), 'from-validated-address');
      assert.equal(lookups, 1, 'a second resolution would reopen the TOCTOU window');
      assert.equal(s.state.connections, 1);
    } finally { await s.close(); }
  });

  test('the lookup handed to the socket returns ONLY validated addresses (public IP first, loopback later in DNS never used)', async () => {
    let captured = null;
    let n = 0;
    const fakeRequest = (options, onResponse) => {
      captured = options;
      const { EventEmitter } = require_('node:events');
      const req = new EventEmitter(); req.destroy = () => {}; req.end = () => setImmediate(() => onResponse(Object.assign(require_('node:stream').Readable.from([Buffer.from('ok')]), { statusCode: 200, statusMessage: 'OK', headers: { 'content-length': '2' } })));
      return req;
    };
    const c = createEgressClient({
      transport: fakeRequest,
      lookup: async () => (n++ === 0 ? [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] : [{ address: '127.0.0.1', family: 4 }]),
    });
    const res = await c.safeFetch('https://rebind.example/');
    assert.equal(await res.text(), 'ok');
    // What the socket layer will call (all=true under happy-eyeballs, or single address):
    const all = await new Promise((ok, ko) => captured.lookup('rebind.example', { all: true }, (e, v) => e ? ko(e) : ok(v)));
    assert.deepEqual(all.map(a => a.address), ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const v4 = await new Promise((ok, ko) => captured.lookup('rebind.example', { family: 4 }, (e, a, f) => e ? ko(e) : ok([a, f])));
    assert.deepEqual(v4, ['93.184.216.34', 4]);
    const v6 = await new Promise((ok, ko) => captured.lookup('rebind.example', { family: 6, all: true }, (e, v) => e ? ko(e) : ok(v)));
    assert.deepEqual(v6.map(a => a.address), ['2606:2800:220:1:248:1893:25c8:1946']);
    // Whatever name the runtime asks for, the answer is the validated set — a different name cannot smuggle a new address in.
    const other = await new Promise((ok, ko) => captured.lookup('127.0.0.1.attacker.example', { all: true }, (e, v) => e ? ko(e) : ok(v)));
    assert.deepEqual(other.map(a => a.address), ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    assert.equal(captured.host, 'rebind.example', 'Host/SNI source stays the hostname');
    assert.equal(captured.agent, false);
    assert.equal(n, 1);
  });

  test('the DNS rebinding scenario of the mission: PUBLIC first, 127.0.0.1 second ⇒ no loopback connection', async () => {
    const target = await startServer((_q, res) => { res.end('INTERNAL'); });
    let n = 0; let pinned = null;
    const c = createEgressClient({
      ports: [target.port],
      lookup: async () => (n++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
      transport: (options, cb) => { pinned = options; const { EventEmitter } = require_('node:events'); const r = new EventEmitter(); r.destroy = () => {}; r.end = () => setImmediate(() => cb(Object.assign(require_('node:stream').Readable.from([Buffer.from('PUBLIC')]), { statusCode: 200, headers: {} }))); return r; },
    });
    try {
      const res = await c.safeFetch(`http://attacker.example:${target.port}/`);
      assert.equal(await res.text(), 'PUBLIC');
      const a = await new Promise((ok, ko) => pinned.lookup('attacker.example', {}, (e, addr) => e ? ko(e) : ok(addr)));
      assert.equal(a, '93.184.216.34');
      assert.equal(target.state.connections, 0, 'loopback target must never be contacted');
      // And a first-resolution that is ALREADY loopback is refused outright:
      n = 1;
      assert.equal(await reason(() => c.safeFetch(`http://attacker.example:${target.port}/`)), EGRESS_REASONS.DNS_PRIVATE);
      assert.equal(target.state.connections, 0);
    } finally { await target.close(); }
  });
});
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('TLS: SNI + certificate verification keep using the HOSTNAME while the socket is pinned to the validated address', () => {
  function makeCert(dir, cn, sans) {
    const key = path.join(dir, `${cn}.key.pem`); const cert = path.join(dir, `${cn}.cert.pem`); const cnf = path.join(dir, 'openssl.cnf');
    if (!fs.existsSync(cnf)) fs.writeFileSync(cnf, '[req]\ndistinguished_name=dn\n[dn]\n', 'utf8');
    execFileSync('openssl', ['req', '-config', cnf, '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${sans.join(',')}`, '-keyout', key, '-out', cert], { windowsHide: true, stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
  }

  test('SNI is the hostname; a certificate for another name is rejected even though the IP is reachable', async (t) => {
    let pair;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-egress-tls-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    try { pair = makeCert(dir, 'sni.test', ['DNS:sni.test']); } catch { return t.skip('openssl unavailable'); }
    const sniSeen = [];
    const s = await startServer((_q, res) => { res.end('tls-ok'); }, { tls: { key: pair.key, cert: pair.cert, SNICallback: (name, cb) => { sniSeen.push(name); cb(null, undefined); } } });
    try {
      const mk = () => fixtureClient([s.port], { lookup: mapTo({ 'sni.test': ['127.0.0.1'], 'wrong.test': ['127.0.0.1'] }), tls: { ca: pair.cert } });
      const ok = await mk().safeFetch(`https://sni.test:${s.port}/`);
      assert.equal(await ok.text(), 'tls-ok');
      assert.ok(sniSeen.includes('sni.test'), `SNI must carry the hostname, saw ${JSON.stringify(sniSeen)}`);
      assert.equal(s.state.requests.at(-1).servername, 'sni.test');
      const bad = await mk().safeFetch(`https://wrong.test:${s.port}/`).catch(e => e);
      assert.match(String(bad.code), /ERR_TLS_CERT_ALTNAME_INVALID/, 'verification is against the hostname, not the pinned IP');
      assert.ok(sniSeen.includes('wrong.test'));
      // Without the fixture CA the self-signed certificate is refused (default trust store is untouched).
      const untrusted = await fixtureClient([s.port], { lookup: mapTo({ 'sni.test': ['127.0.0.1'] }) }).safeFetch(`https://sni.test:${s.port}/`).catch(e => e);
      assert.match(String(untrusted.code), /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED|UNABLE_TO_VERIFY/);
    } finally { await s.close(); }
  });

  test('https → http downgrade on redirect is refused; http → https is fine', async (t) => {
    let pair;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-egress-tls-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    try { pair = makeCert(dir, 'dg.test', ['DNS:dg.test']); } catch { return t.skip('openssl unavailable'); }
    const plain = await startServer((_q, res) => { res.end('plain'); });
    const secure = await startServer((req, res) => {
      if (req.url === '/down') { res.writeHead(302, { location: `http://dg.test:${plain.port}/` }); return res.end(); }
      res.end('secure');
    }, { tls: { key: pair.key, cert: pair.cert } });
    const up = await startServer((_q, res) => { res.writeHead(302, { location: `https://dg.test:${secure.port}/` }); res.end(); });
    try {
      const c = fixtureClient([plain.port, secure.port, up.port], { lookup: mapTo({ 'dg.test': ['127.0.0.1'] }), tls: { ca: pair.cert } });
      assert.equal(await reason(() => c.safeFetch(`https://dg.test:${secure.port}/down`)), EGRESS_REASONS.REDIRECT_DOWNGRADE);
      assert.equal(plain.state.connections, 0);
      assert.equal(await (await c.safeFetch(`http://127.0.0.1:${up.port}/`)).text(), 'secure');
    } finally { await plain.close(); await secure.close(); await up.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('FIXED_EXTERNAL_PROVIDER mode (trustedHosts): first hop by the runtime fetch, every redirect hop validated + pinned', () => {
  const ok = (extra = {}) => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return { fine: true }; }, ...extra });

  test('a plain mocked fetch (as used by the existing provider tests) keeps working and is returned untouched', async () => {
    const calls = [];
    const c = createEgressClient({ fetchImpl: async (url, init) => { calls.push({ url, init }); return ok(); } });
    const res = await c.safeFetch('https://raw.githubusercontent.com/x/y.json', { trustedHosts: ['raw.githubusercontent.com'] });
    assert.deepEqual(await res.json(), { fine: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'manual', 'the runtime must never follow redirects by itself');
  });

  test('the first hop must be a listed host, https, and not an IP literal', async () => {
    const c = createEgressClient({ fetchImpl: async () => ok() });
    assert.equal(await reason(() => c.safeFetch('https://other.example/', { trustedHosts: ['raw.githubusercontent.com'] })), EGRESS_REASONS.HOST_NOT_TRUSTED);
    const calls = []; let transportCalls = 0;
    const c2 = createEgressClient({
      fetchImpl: async (u) => { calls.push(u); return ok(); },
      lookup: mapTo({ 'raw.githubusercontent.com': ['127.0.0.1'] }), // would be refused: proves the http request went through FULL validation
      transport: () => { transportCalls++; throw new Error('must not connect'); },
    });
    assert.equal(await reason(() => c2.safeFetch('http://raw.githubusercontent.com/x', { trustedHosts: ['raw.githubusercontent.com'] })), EGRESS_REASONS.DNS_PRIVATE, 'http is not eligible for the trusted shortcut');
    assert.equal(calls.length, 0); assert.equal(transportCalls, 0);
  });

  test('a redirect from a trusted host to a forbidden destination is refused; to a public one it goes through the PINNED path', async () => {
    const bad = ['http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://10.1.1.1/', 'http://169.254.169.254/', 'file:///x', 'https://user:p@cdn.example/'];
    for (const location of bad) {
      let fetchCalls = 0;
      const c = createEgressClient({ fetchImpl: async () => { fetchCalls++; return { status: 302, ok: false, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) }, body: null }; } });
      const r = await reason(() => c.safeFetch('https://huggingface.co/m.bin', { trustedHosts: ['huggingface.co'] }));
      assert.ok(r.startsWith('BLOCKED_'), `${location} → ${r}`);
      assert.equal(fetchCalls, 1, 'the redirect target must not be fetched by the runtime');
    }
    // public CDN hop: resolver validated, transport pinned (fake transport — no packet sent)
    let pinnedTo = null;
    const c = createEgressClient({
      lookup: mapTo({ 'cdn.example': ['93.184.216.34'] }),
      fetchImpl: async () => ({ status: 302, ok: false, headers: { get: () => 'https://cdn.example/file.bin' }, body: null }),
      transport: (options, cb) => { pinnedTo = options; const { EventEmitter } = require_('node:events'); const r = new EventEmitter(); r.destroy = () => {}; r.end = () => setImmediate(() => cb(Object.assign(require_('node:stream').Readable.from([Buffer.from('BIN')]), { statusCode: 200, headers: {} }))); return r; },
    });
    const res = await c.safeFetch('https://huggingface.co/m.bin', { trustedHosts: ['huggingface.co'] });
    assert.equal(await res.text(), 'BIN');
    assert.equal(pinnedTo.host, 'cdn.example');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('structured logging: reason + hostname only, never credentials / query / path / headers', () => {
  test('blocked events carry BLOCKED_* reasons and no secret', async () => {
    const events = [];
    setEgressLogger({ warn: (obj, msg) => events.push({ obj, msg }) });
    try {
      await reason(() => safeFetch('http://user:SUPERSECRETPW@example.com/path?token=QUERYSECRET'));
      await reason(() => safeFetch('http://[::ffff:127.0.0.1]/private/path?apikey=QUERYSECRET', { headers: { Authorization: 'Bearer HEADERSECRET', Cookie: 'sid=COOKIESECRET' } }));
      await reason(() => safeFetch('file:///C:/Users/secret/file.txt'));
      assert.equal(events.length, 3);
      assert.deepEqual(events.map(e => e.obj.reason), ['BLOCKED_USERINFO', 'BLOCKED_LOOPBACK', 'BLOCKED_SCHEME']);
      const dump = JSON.stringify(events);
      for (const secret of ['SUPERSECRETPW', 'QUERYSECRET', 'HEADERSECRET', 'COOKIESECRET', '/private/path', 'secret/file']) assert.ok(!dump.includes(secret), `log leaked ${secret}`);
      assert.ok(events.every(e => e.msg === 'EGRESS_BLOCKED' && e.obj.event === 'EGRESS_BLOCKED'));
    } finally { setEgressLogger(null); }
  });

  test('a throwing logger can never change the security decision', async () => {
    setEgressLogger({ warn: () => { throw new Error('logger down'); } });
    try { assert.equal(await reason(() => safeFetch('http://127.0.0.1/')), 'BLOCKED_LOOPBACK'); assert.equal(await reason(() => validateOutboundUrl('http://127.0.0.1/')), 'BLOCKED_LOOPBACK'); } finally { setEgressLogger(null); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('browser (Playwright) request guard — routing logic with a fake context', () => {
  function fakeContext() {
    const ctx = { handler: null, async route(_p, h) { ctx.handler = h; } };
    ctx.fire = async (url) => { const out = { action: null }; await ctx.handler({ request: () => ({ url: () => url }), continue: async () => { out.action = 'continue'; }, abort: async (why) => { out.action = `abort:${why}`; } }); return out.action; };
    return ctx;
  }

  test('public requests continue; loopback / mapped / private / metadata / non-standard port / bad scheme are aborted; data:/blob:/about: pass', async () => {
    const client = createEgressClient({ lookup: mapTo({ 'www.example.com': ['93.184.216.34'], 'rebinder.example': ['127.0.0.1'], 'cdn.example.com': ['93.184.216.35'] }) });
    const ctx = fakeContext(); const blocked = [];
    await installBrowserEgressGuard(ctx, { client, onBlocked: e => blocked.push(e.code) });
    assert.equal(await ctx.fire('https://www.example.com/a.js'), 'continue');
    assert.equal(await ctx.fire('https://cdn.example.com/x.png'), 'continue');
    for (const u of ['http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://10.0.0.1/x', 'http://169.254.169.254/', 'http://rebinder.example/', 'https://www.example.com:8443/', 'ftp://www.example.com/', 'file:///C:/x', 'https://nxdomain.example/', 'not a url']) assert.equal(await ctx.fire(u), 'abort:blockedbyclient', u);
    for (const u of ['data:text/html,hi', 'blob:https://www.example.com/uuid', 'about:blank']) assert.equal(await ctx.fire(u), 'continue', u);
    assert.ok(blocked.length >= 10);
  });

  test('host validation is cached briefly (one DNS query per host inside the window)', async () => {
    let q = 0;
    const client = createEgressClient({ lookup: async () => { q++; return [{ address: '93.184.216.34', family: 4 }]; } });
    const ctx = fakeContext();
    await installBrowserEgressGuard(ctx, { client, cacheMs: 60_000 });
    for (let i = 0; i < 5; i++) assert.equal(await ctx.fire('https://www.example.com/r' + i), 'continue');
    assert.equal(q, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('policy defaults', () => {
  test('the default client is strict: nothing but 80/443 and public addresses; max 5 redirects', () => {
    assert.deepEqual([...createEgressClient({})._config.ports], [80, 443]);
    assert.equal(createEgressClient({})._config.maxRedirects, 5);
    assert.equal(createEgressClient({})._config.addressPolicy({ public: false }), false);
    assert.equal(createEgressClient({})._config.addressPolicy({ public: true }), true);
  });
});
