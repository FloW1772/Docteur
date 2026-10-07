// Media Reader V1 — unit tests of the pure logic (src/lib/media/media-resource.ts, Node type stripping) + static audit.
// Usage: node --test scripts/test-media-reader-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  KIND_LABEL, LOAD_TIMEOUT_MS, UNSUPPORTED_MESSAGE, classifyMediaResource, fetchPdfBytes, fetchTextResource, initialReaderState,
  isPrivateHost, kindFromMime, linkMediaKind, mediaErrorEvent, readerReducer,
} from '../src/lib/media/media-resource.ts';

const API = 'http://127.0.0.1:3001';
const c = (url, extra = {}) => classifyMediaResource({ url, ...extra }, { apiOrigin: API });

test('classification: video / audio / image / pdf / text / web by extension', () => {
  const table = [
    ['https://cdn.example.org/clip.mp4', 'video'], ['https://cdn.example.org/clip.webm', 'video'], ['https://cdn.example.org/a/b/clip.M4V?x=1', 'video'],
    ['https://cdn.example.org/song.mp3', 'audio'], ['https://cdn.example.org/s.wav', 'audio'], ['https://cdn.example.org/s.ogg', 'audio'],
    ['https://cdn.example.org/s.m4a', 'audio'], ['https://cdn.example.org/s.aac', 'audio'], ['https://cdn.example.org/s.flac', 'audio'],
    ['https://img.example.org/p.jpg', 'image'], ['https://img.example.org/p.JPEG', 'image'], ['https://img.example.org/p.png', 'image'],
    ['https://img.example.org/p.webp', 'image'], ['https://img.example.org/p.gif', 'image'], ['https://img.example.org/p.svg', 'image'],
    ['https://docs.example.org/rapport.pdf', 'pdf'],
    ['https://raw.example.org/notes.txt', 'text'], ['https://raw.example.org/README.md', 'text'], ['https://raw.example.org/data.json', 'text'],
    ['https://www.lemonde.fr/article/2026/10/05/titre', 'web'], ['https://example.org/', 'web'], ['https://example.org/page.html', 'web'],
  ];
  for (const [url, kind] of table) assert.equal(c(url).kind, kind, url);
  assert.equal(c('https://raw.example.org/README.md').markdown, true);
  assert.equal(c('https://raw.example.org/notes.txt').markdown, false);
});

test('classification: a reliable MIME wins over a misleading extension', () => {
  assert.equal(c('https://files.example.org/download.bin', { mimeType: 'application/pdf' }).kind, 'pdf');
  assert.equal(c('https://files.example.org/fake.mp4', { mimeType: 'image/png' }).kind, 'image');
  assert.equal(c('https://files.example.org/x', { mimeType: 'audio/mpeg; charset=binary' }).kind, 'audio');
  assert.equal(c('https://files.example.org/x', { mimeType: 'text/markdown' }).markdown, true);
  assert.equal(c('https://files.example.org/x.txt', { mimeType: 'application/octet-stream' }).kind, 'text', 'an uninformative MIME falls back to the extension');
  assert.equal(kindFromMime('text/html'), 'web');
  assert.equal(kindFromMime(''), null);
});

test('classification: YouTube video, Short, live, embed, youtu.be, playlist — channels are web pages', () => {
  const v = c('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10');
  assert.equal(v.kind, 'youtube');
  assert.equal(v.youtube.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1', 'same embed as the historical player');
  assert.equal(c('https://youtu.be/dQw4w9WgXcQ').youtube.videoId, 'dQw4w9WgXcQ');
  const short = c('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(short.kind, 'youtube'); assert.equal(short.youtube.isShort, true, 'Shorts now open in Docteur (they had no button before)');
  assert.equal(c('https://www.youtube.com/live/dQw4w9WgXcQ').kind, 'youtube');
  assert.equal(c('https://m.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'youtube');
  const pl = c('https://www.youtube.com/playlist?list=PLabcdef12');
  assert.equal(pl.kind, 'youtube'); assert.match(pl.youtube.embedUrl, /embed\/videoseries\?list=PLabcdef12/);
  assert.equal(c('https://www.youtube.com/@chaine').kind, 'web');
  assert.equal(c('https://www.youtube.com/watch?v=<script>').kind, 'web', 'an invalid id is never put in the embed URL');
  assert.equal(c('https://evil.example/watch?v=dQw4w9WgXcQ').kind, 'web', 'not a YouTube host');
  assert.equal(c('https://notyoutube.com/watch?v=dQw4w9WgXcQ').kind, 'web');
});

test('classification: mov / mkv are tried but flagged uncertain (no false promise of native playback)', () => {
  assert.equal(c('https://cdn.example.org/a.mov').kind, 'video');
  assert.equal(c('https://cdn.example.org/a.mov').nativeSupport, 'uncertain');
  assert.equal(c('https://cdn.example.org/a.mkv').nativeSupport, 'uncertain');
  assert.equal(c('https://cdn.example.org/a.mp4').nativeSupport, 'yes');
});

test('classification: unknown formats → unknown (explicit fallback), Docteur local routes recognised', () => {
  assert.equal(c(`${API}/api/files/originals/abc/download`).kind, 'unknown', 'local download without MIME: fallback (download offered)');
  assert.equal(c(`${API}/api/files/originals/abc/download`, { mimeType: 'application/pdf' }).kind, 'pdf');
  assert.equal(c(`${API}/api/image/1234.png`).kind, 'image');
  assert.equal(c(`${API}/api/image/abcd`).kind, 'image', 'image route without extension');
  const audio = c(`${API}/api/audio-player/file?path=${encodeURIComponent('C:\\Musique\\piste.mp3')}`);
  assert.equal(audio.kind, 'audio'); assert.equal(audio.docteurLocal, true);
  assert.equal(c('https://cdn.example.org/archive.zip').kind, 'web', 'a remote non-media URL is treated as a link to open, not executed');
  assert.equal(c(`${API}/api/whatever.zip`).kind, 'unknown');
});

test('security: dangerous schemes, malformed URLs, credentials and private hosts are blocked (and never become media)', () => {
  const blocked = [
    ['javascript:alert(1)', 'dangerous_scheme'], ['JaVaScRiPt:alert(1)', 'dangerous_scheme'], ['data:text/html,<script>alert(1)</script>', 'dangerous_scheme'],
    ['file:///C:/Windows/win.ini', 'dangerous_scheme'], ['vbscript:msgbox', 'dangerous_scheme'], ['blob:https://evil/abc', 'dangerous_scheme'], ['ftp://x/y.mp4', 'dangerous_scheme'],
    ['not a url', 'invalid_url'], ['', 'invalid_url'], ['http://', 'invalid_url'], [`https://x.org/${'a'.repeat(5000)}`, 'invalid_url'],
    ['https://user:pass@example.org/a.mp4', 'credentials_in_url'],
    ['http://localhost/a.mp4', 'private_network'], ['http://127.0.0.1:8080/a.mp4', 'private_network'], ['http://2130706433/a.png', 'private_network'],
    ['http://0x7f.0.0.1/a.png', 'private_network'], ['http://10.0.0.5/a.pdf', 'private_network'], ['http://192.168.1.1/admin', 'private_network'],
    ['http://172.20.1.1/x.txt', 'private_network'], ['http://169.254.169.254/latest/meta-data', 'private_network'], ['http://[::1]/a.mp3', 'private_network'],
    ['http://[fe80::1]/a', 'private_network'], ['http://[fd00::1]/a', 'private_network'], ['http://printer.local/a.png', 'private_network'],
    ['http://0.0.0.0/a', 'private_network'], ['http://127.0.0.1:3000/api/image/x.png', 'private_network'],
  ];
  for (const [url, reason] of blocked) {
    const d = c(url);
    assert.equal(d.blocked?.reason, reason, url);
    assert.equal(d.kind, 'unknown', `${url}: never a playable kind`);
    assert.equal(initialReaderState(d).phase, 'ERROR', `${url}: the reader opens on an explanation, no viewer`);
  }
  assert.equal(c(`${API}/api/image/x.png`).blocked, null, 'only the exact Docteur API origin is exempt');
  assert.equal(isPrivateHost('example.org'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(linkMediaKind('http://192.168.0.1/a.mp4'), 'unknown', 'no "open in Docteur" button for a private host');
  assert.equal(linkMediaKind(`${API}/api/audio-player/file?path=C%3A%5Ca.mp3`, API), 'audio', 'Docteur-local media links DO get the button (regression found by the browser test)');
  assert.equal(linkMediaKind(`${API}/api/audio-player/file?path=C%3A%5Ca.mp3`), 'unknown', 'without the API origin a loopback URL stays refused');
});

test('descriptor: stable id per resource (switching media resets), default title, labels', () => {
  assert.equal(c('https://a.org/x.mp4').id, c('https://a.org/x.mp4').id);
  assert.notEqual(c('https://a.org/x.mp4').id, c('https://a.org/y.mp4').id);
  assert.equal(c('https://www.a.org/dir/x.mp4').title, 'a.org/dir/x.mp4');
  assert.equal(c('https://a.org/x.mp4', { title: '  Mon clip ' }).title, 'Mon clip');
  for (const kind of ['youtube', 'video', 'audio', 'image', 'pdf', 'text', 'web', 'unknown']) assert.ok(KIND_LABEL[kind]);
});

test('reader state: OPENING → LOADING → READY; slow hint; timeout → ERROR; late events ignored; retry restarts', () => {
  let s = initialReaderState(c('https://a.org/x.mp4'));
  assert.equal(s.phase, 'OPENING');
  s = readerReducer(s, { type: 'start' }); assert.equal(s.phase, 'LOADING');
  s = readerReducer(s, { type: 'slow' }); assert.equal(s.slow, true);
  const ready = readerReducer(s, { type: 'ready' }); assert.equal(ready.phase, 'READY'); assert.equal(ready.slow, false);
  const timedOut = readerReducer(s, { type: 'timeout' });
  assert.equal(timedOut.phase, 'ERROR'); assert.match(timedOut.message, /délai dépassé/);
  assert.equal(readerReducer(timedOut, { type: 'ready' }).phase, 'ERROR', 'a late "ready" after the timeout does not flip the screen');
  assert.equal(readerReducer(ready, { type: 'error', message: 'x' }).phase, 'READY', 'a late error after ready is ignored');
  assert.equal(readerReducer(timedOut, { type: 'start' }).phase, 'LOADING', 'retry');
  assert.equal(readerReducer(s, { type: 'unsupported' }).message, UNSUPPORTED_MESSAGE);
  assert.ok(LOAD_TIMEOUT_MS >= 10_000 && LOAD_TIMEOUT_MS <= 60_000, 'reasonable timeout, never infinite');
});

test('reader state: web is a card (ready at once), unknown is UNSUPPORTED at once — no empty box, no spinner', () => {
  assert.equal(initialReaderState(c('https://www.lemonde.fr/a')).phase, 'READY');
  assert.equal(initialReaderState(c(`${API}/api/x.zip`)).phase, 'UNSUPPORTED');
});

test('media element errors: decode / not-supported → UNSUPPORTED, network → ERROR', () => {
  assert.equal(mediaErrorEvent(4).type, 'unsupported');
  assert.equal(mediaErrorEvent(3).type, 'unsupported');
  assert.equal(mediaErrorEvent(2).type, 'error');
  assert.match(mediaErrorEvent(2).message, /réseau/);
  assert.equal(mediaErrorEvent(undefined).type, 'error');
});

// ── bounded reads with a fake fetch ─────────────────────────────────────────────────────────────────────────────────
const streamOf = (chunks) => new ReadableStream({ start(ctrl) { for (const ch of chunks) ctrl.enqueue(new TextEncoder().encode(ch)); ctrl.close(); } });
const fakeFetch = (body, { status = 200, type = 'text/plain' } = {}) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response(typeof body === 'string' ? streamOf([body]) : body, { status, headers: { 'content-type': type } }); };
  return { impl, calls };
};

test('fetchTextResource: reads text, never sends credentials/referrer, bounded size, refuses non-text, reports HTTP errors', async () => {
  const ok = fakeFetch('# Titre\nbonjour', { type: 'text/markdown; charset=utf-8' });
  const r = await fetchTextResource('https://raw.example.org/a.md', { signal: new AbortController().signal, fetchImpl: ok.impl });
  assert.equal(r.text, '# Titre\nbonjour'); assert.equal(r.truncated, false);
  assert.equal(ok.calls[0].init.credentials, 'omit'); assert.equal(ok.calls[0].init.referrerPolicy, 'no-referrer');
  const big = fakeFetch(streamOf(['a'.repeat(600), 'b'.repeat(600)]));
  const t = await fetchTextResource('https://x.org/a.txt', { signal: new AbortController().signal, fetchImpl: big.impl, maxBytes: 1000 });
  assert.equal(t.text.length, 1000); assert.equal(t.truncated, true);
  await assert.rejects(fetchTextResource('https://x.org/a.txt', { signal: new AbortController().signal, fetchImpl: fakeFetch('<html>', { type: 'application/octet-stream' }).impl }), e => e.unsupported === true);
  await assert.rejects(fetchTextResource('https://x.org/a.txt', { signal: new AbortController().signal, fetchImpl: fakeFetch('nope', { status: 404 }).impl }), /HTTP 404/);
});

test('fetchTextResource: abort stops the read (close during loading)', async () => {
  const ctrl = new AbortController();
  let pulls = 0;
  const endless = new ReadableStream({ pull(c2) { pulls += 1; c2.enqueue(new TextEncoder().encode('x'.repeat(10))); if (pulls === 3) ctrl.abort(); } });
  await assert.rejects(fetchTextResource('https://x.org/a.txt', { signal: ctrl.signal, fetchImpl: fakeFetch(endless).impl }), e => e.name === 'AbortError');
  assert.ok(pulls < 10, `stopped after the abort (${pulls} pulls)`);
});

test('fetchPdfBytes: only real PDF bytes (%PDF-), size bounded', async () => {
  const pdf = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
  const bytes = await fetchPdfBytes('https://x.org/a.pdf', { signal: new AbortController().signal, fetchImpl: fakeFetch(pdf, { type: 'application/pdf' }).impl });
  assert.equal(new TextDecoder().decode(bytes), pdf);
  await assert.rejects(fetchPdfBytes('https://x.org/a.pdf', { signal: new AbortController().signal, fetchImpl: fakeFetch('<html><script>x</script>', { type: 'application/pdf' }).impl }), e => e.unsupported === true && /pas un PDF/.test(e.message));
  await assert.rejects(fetchPdfBytes('https://x.org/a.pdf', { signal: new AbortController().signal, fetchImpl: fakeFetch(`%PDF-${'x'.repeat(100)}`).impl, maxBytes: 50 }), e => e.unsupported === true);
});

// ── static audit ────────────────────────────────────────────────────────────────────────────────────────────────────
test('static audit: no shell, no HTML injection, no eval, no new server path; iframes only for YouTube embed and verified PDF blobs', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const files = ['src/lib/media/media-resource.ts', 'src/components/media/MediaReader.tsx', 'src/components/media/MediaOpenButton.tsx'];
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /child_process|dangerouslySetInnerHTML|\.innerHTML|\beval\(|new Function\(|document\.write|srcdoc/, f);
    const code = text.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(code, /\/api\/(?!image|audio-player|files)/, `${f}: calls no backend route of its own`);
  }
  const reader = read('src/components/media/MediaReader.tsx');
  const iframeSrcs = [...reader.matchAll(/<iframe[\s\S]*?src=\{([^}]+)\}/g)].map(m => m[1].trim());
  assert.deepEqual(iframeSrcs.sort(), ['descriptor.youtube?.embedUrl', 'objectUrl'].sort(), 'no remote page is ever iframed');
  assert.match(reader, /URL\.revokeObjectURL/, 'object URLs are revoked');
  assert.match(reader, /removeEventListener\('keydown'/, 'listener removed');
  assert.match(reader, /controller\.abort\(\)/, 'fetches aborted on close / timeout');
  assert.match(reader, /media\.removeAttribute\('src'\)/, 'media download stopped on close');
  const app = read('src/App.tsx');
  assert.doesNotMatch(app, /setActiveVideo|youtube-nocookie/, 'one reader only: the old YouTube-only overlay is gone (its embed lives in the reader)');
  assert.match(app, /onOpenInBrowser=\{async url => \{ await cortexClient\.openInBrowser\(url\); \}\}/, 'web bridge = the existing Browser module');
});
