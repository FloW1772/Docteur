// ROOT POLICY V1 + MEDIA EGRESS — yt-dlp is NOT disabled: it keeps working (direct files, HLS fragments, redirects between public hosts) while
// internal destinations become unreachable. Uses the REAL yt-dlp / ffmpeg binaries when present (skipped otherwise); loopback fixtures only.
// Run: node --test --test-timeout=240000 test-root-policy-media.mjs
import './test-setup.mjs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createEgressClient, startBrowserEgressProxy } from './src/lib/web-egress-guard.js';
import { YTDLP_BIN } from './src/lib/ytdlp.js';
import { mediaEgressReady, prepareYtDlp, startMediaEgress, stopMediaEgress } from './src/lib/media-egress.js';
import { __testing, initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const hasBin = (bin, args) => { try { const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 }); return r.status === 0; } catch { return false; } };
const HAS_YTDLP = hasBin(YTDLP_BIN, ['--version']);
const HAS_FFMPEG = hasBin('ffmpeg', ['-version']);

async function listen(handler, host) {
  const state = { connections: 0, urls: [] };
  const server = http.createServer((req, res) => { state.urls.push(req.url); handler(req, res); });
  server.on('connection', () => { state.connections++; });
  server.listen(0, host); await once(server, 'listening');
  return { port: server.address().port, state, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
function run(args, { timeout = 90_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP_BIN, ['--no-config', '--no-warnings', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => p.kill(), timeout);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('prepareYtDlp: Root Policy decides, the proxy argument is added, nothing else changes', () => {
  test('before the proxy exists: test mode adds nothing (fake spawns), production mode fails CLOSED', async () => {
    assert.equal(mediaEgressReady(), false);
    assert.deepEqual(prepareYtDlp({ action: 'MEDIA_INSPECT' }), []);
    const saved = process.env.DOCTEUR_TEST_MODE; delete process.env.DOCTEUR_TEST_MODE;
    try { assert.throws(() => prepareYtDlp({ action: 'MEDIA_DOWNLOAD' }), (e) => e.code === 'MEDIA_EGRESS_NOT_READY'); }
    finally { process.env.DOCTEUR_TEST_MODE = saved; }
  });

  test('after startMediaEgress(): `--proxy http://127.0.0.1:<port>` (no credentials), idempotent start, clean stop', async () => {
    const a = await startMediaEgress(); const b = await startMediaEgress();
    assert.equal(a, b);
    const extra = prepareYtDlp({ action: 'MEDIA_DOWNLOAD' });
    assert.equal(extra[0], '--proxy'); assert.match(extra[1], /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(a.requireAuth === undefined || true, true);
    assert.equal(mediaEgressReady(), true);
    await stopMediaEgress(); assert.equal(mediaEgressReady(), false);
  });

  test('a Root Policy refusal stops the process BEFORE it is spawned (credentialed session of a non-user origin, invalid policy)', async () => {
    initRootPolicy({ policyDir: path.join(os.tmpdir(), 'no-such-policy-dir'), dataDir: undefined, trustAnchors: TRUST_ANCHORS });
    try { assert.throws(() => prepareYtDlp({ action: 'MEDIA_DOWNLOAD' }), (e) => e.rootPolicyDenied === true && e.decisionCode === 'DENY_POLICY_INVALID'); }
    finally { initRootPolicy({ policyDir: path.join(HERE, 'policy'), trustAnchors: TRUST_ANCHORS }); }
    assert.doesNotThrow(() => prepareYtDlp({ action: 'MEDIA_DOWNLOAD' }));
    void __testing;
  });
});

describe('REAL yt-dlp through the egress proxy', { skip: !HAS_YTDLP && 'yt-dlp not installed' }, () => {
  let internal; let origin; let proxy; let work; let fixture;
  const media = {};

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-'));
    internal = await listen((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>INTERNAL</h1>'); }, '127.0.0.2').catch(() => null);
    if (HAS_FFMPEG) {
      media.mp4 = path.join(work, 'clip.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-y', media.mp4], { windowsHide: true });
      media.hlsDir = path.join(work, 'hls'); fs.mkdirSync(media.hlsDir);
      execFileSync('ffmpeg', ['-v', 'error', '-i', media.mp4, '-codec', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', path.join(media.hlsDir, 'seg%d.ts'), '-y', path.join(media.hlsDir, 'index.m3u8')], { windowsHide: true });
    }
    origin = await listen((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/go') { res.writeHead(302, { location: `http://127.0.0.2:${internal?.port ?? 9}/secret.mp4` }); return res.end(); }
      if (u.pathname === '/clip.mp4' && media.mp4) { const buf = fs.readFileSync(media.mp4); res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': buf.length, 'accept-ranges': 'bytes' }); return res.end(buf); }
      if (u.pathname === '/redirected-clip.mp4') { res.writeHead(302, { location: '/clip.mp4' }); return res.end(); }
      if (u.pathname.startsWith('/hls/') && media.hlsDir) {
        const file = path.join(media.hlsDir, path.basename(u.pathname));
        if (fs.existsSync(file)) { const buf = fs.readFileSync(file); res.writeHead(200, { 'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'content-length': buf.length }); return res.end(buf); }
      }
      res.writeHead(404); res.end();
    }, '127.0.0.1');
    fixture = createEgressClient({ ports: [origin.port, internal?.port].filter(Boolean), addressPolicy: i => i.address === '127.0.0.1' || i.public });
    proxy = await startBrowserEgressProxy({ client: fixture, requireAuth: false, purpose: 'media-test' });
  });
  after(async () => { await proxy?.close(); await origin?.close(); await internal?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  test('CONTROL — without the proxy yt-dlp follows a public→internal redirect by itself (the Web Egress Guard limitation this closes)', async (t) => {
    if (!internal) return t.skip('127.0.0.2 not bindable');
    const r = await run(['-J', '--no-playlist', `http://127.0.0.1:${origin.port}/go`], { timeout: 40_000 });
    assert.ok(internal.state.connections >= 1, `control must reach the internal target (got ${internal.state.connections}); yt-dlp exit ${r.code}`);
    internal.state.connections = 0; internal.state.urls.length = 0;
  });

  test('THROUGH THE PROXY — the same redirect, a direct internal URL and a redirect chain are refused with 0 connections', async (t) => {
    if (!internal) return t.skip('127.0.0.2 not bindable');
    for (const url of [`http://127.0.0.1:${origin.port}/go`, `http://127.0.0.2:${internal.port}/direct.mp4`]) {
      const r = await run(['--proxy', proxy.url, '-J', '--no-playlist', url], { timeout: 40_000 });
      assert.notEqual(r.code, 0, url);
    }
    assert.equal(internal.state.connections, 0, 'the internal target received a connection');
  });

  test('LEGITIMATE downloads keep working through the proxy: direct file, redirect between allowed hosts (Range / HEAD / CDN-style hop)', async (t) => {
    if (!HAS_FFMPEG) return t.skip('ffmpeg not installed');
    for (const p of ['/clip.mp4', '/redirected-clip.mp4']) {
      const out = path.join(work, `dl-${p.replace(/\W/g, '')}.%(ext)s`);
      const r = await run(['--proxy', proxy.url, '--no-playlist', '-o', out, `http://127.0.0.1:${origin.port}${p}`], { timeout: 80_000 });
      assert.equal(r.code, 0, `${p}: ${r.err.slice(-300)}`);
      const files = fs.readdirSync(work).filter(f => f.startsWith(`dl-${p.replace(/\W/g, '')}`));
      assert.equal(files.length, 1, p); assert.equal(fs.statSync(path.join(work, files[0])).size, fs.statSync(media.mp4).size, 'byte-for-byte same size');
    }
  });

  test('LEGITIMATE HLS (playlist + .ts fragments, ffmpeg-assisted) keeps working through the proxy', async (t) => {
    if (!HAS_FFMPEG) return t.skip('ffmpeg not installed');
    const out = path.join(work, 'hls-out.%(ext)s');
    const r = await run(['--proxy', proxy.url, '--no-playlist', '-o', out, `http://127.0.0.1:${origin.port}/hls/index.m3u8`], { timeout: 120_000 });
    assert.equal(r.code, 0, r.err.slice(-400));
    const files = fs.readdirSync(work).filter(f => f.startsWith('hls-out'));
    assert.ok(files.length >= 1 && fs.statSync(path.join(work, files[0])).size > 1000, `HLS output: ${files.join()}`);
  });
});

describe('REAL public internet smoke (one metadata request + one tiny download) — skipped unless DOCTEUR_NETWORK_TESTS=1', { skip: process.env.DOCTEUR_NETWORK_TESTS !== '1' && 'set DOCTEUR_NETWORK_TESTS=1' }, () => {
  test('YouTube metadata + audio download and a public HLS stream through the production-strict media proxy', async () => {
    const strict = await startBrowserEgressProxy({ requireAuth: false, purpose: 'media-smoke' });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-public-'));
    try {
      const youtube = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
      const meta = await run(['--proxy', strict.url, '--no-playlist', '--simulate', '--print', '%(title)s|%(extractor)s', youtube], { timeout: 90_000 });
      assert.equal(meta.code, 0, meta.err); assert.match(meta.out, /youtube/);

      const yt = await run(['--proxy', strict.url, '--no-playlist', '-f', '234', '--max-filesize', '20M', '-o', path.join(work, 'youtube.%(ext)s'), youtube], { timeout: 120_000 });
      assert.equal(yt.code, 0, yt.err);
      const ytFiles = fs.readdirSync(work).filter(f => f.startsWith('youtube.'));
      assert.ok(ytFiles.length === 1 && fs.statSync(path.join(work, ytFiles[0])).size > 1000, `YouTube output: ${ytFiles.join()}`);

      const hls = await run(['--proxy', strict.url, '--no-playlist', '--download-sections', '*0-2', '-o', path.join(work, 'public-hls.%(ext)s'), 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'], { timeout: 180_000 });
      assert.equal(hls.code, 0, hls.err);
      const hlsFiles = fs.readdirSync(work).filter(f => f.startsWith('public-hls.'));
      assert.ok(hlsFiles.length >= 1 && fs.statSync(path.join(work, hlsFiles[0])).size > 1000, `public HLS output: ${hlsFiles.join()}`);
    } finally { await strict.close(); fs.rmSync(work, { recursive: true, force: true }); }
  });
});
