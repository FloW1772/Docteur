import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAudioDownloader } from './src/lib/video-audio-download.js';

function fixture(results) {
  const calls = [], logs = [];
  const download = createAudioDownloader((bin, args, options) => {
    calls.push({ bin, args, options });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => queueMicrotask(() => proc.emit('close', null));
    const result = results.shift();
    if (result !== 'hang') queueMicrotask(() => {
      proc.stdout.emit('data', '[download] 42.0%');
      for (const part of result?.stderr ?? []) proc.stderr.emit('data', part);
      if (result?.error) proc.emit('error', { code: result.error });
      proc.emit('close', result?.code ?? 0);
    });
    return proc;
  });
  const options = { browser: '', logger: { debug: d => logs.push(d), warn: d => logs.push(d) } };
  return { calls, logs, options, run: extra => download('https://www.youtube.com/watch?v=test&token=SECRET', 'C:/private/out.%(ext)s', { ...options, ...extra }) };
}
const forbidden = () => ({ code: 1, stderr: ['ERROR: unable to download video data: HTTP Error ', '403: Forbidden\n'] });

test('successful download and progress, Windows argv without shell', async () => {
  const f = fixture([{}]); let progress;
  await f.run({ onProgress: p => progress = p });
  assert.equal(f.calls.length, 1); assert.equal(progress.percent, 42);
  assert.equal(f.calls[0].options.shell, undefined);
  assert.ok(f.calls[0].args.includes('wav'));
});
test('generic failure does not retry or expose stderr to UI', async () => {
  const f = fixture([{ code: 1, stderr: ['private details'] }]);
  await assert.rejects(f.run(), /logs du serveur/); assert.equal(f.calls.length, 1);
});
test('403 triggers explicit audio fallback and succeeds', async () => {
  const f = fixture([forbidden(), {}]); await f.run();
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].args.includes('bestaudio[ext=m4a]/bestaudio/best'));
});
test('403 without browser stops after two attempts', async () => {
  const f = fixture([forbidden(), forbidden()]);
  await assert.rejects(f.run(), /Le site refuse/); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => !c.args.includes('--cookies-from-browser')));
});
for (const browser of ['chrome', 'firefox']) test(`configured ${browser} is only used on third attempt`, async () => {
  const f = fixture([forbidden(), forbidden(), {}]); await f.run({ browser });
  assert.equal(f.calls.length, 3);
  assert.ok(!f.calls[0].args.includes(browser));
  assert.ok(f.calls[2].args.includes('--cookies-from-browser')); assert.ok(f.calls[2].args.includes(browser));
});
test('all strategies fail once', async () => {
  const f = fixture([forbidden(), forbidden(), forbidden()]);
  await assert.rejects(f.run({ browser: 'chrome' }), /session navigateur/); assert.equal(f.calls.length, 3);
});
test('generic fallback failure stops retries', async () => {
  const f = fixture([forbidden(), {code: 1, stderr: ['format unavailable']}]);
  await assert.rejects(f.run({browser: 'chrome'})); assert.equal(f.calls.length, 2);
});
test('logs redact secrets, URL, headers and profile path, retaining 403', async () => {
  const f = fixture([{code: 1, stderr: ['HTTP Error 403: Forbidden\nCookie: SESSION_SECRET\nAuthorization: Bearer AUTH_SECRET\npassword=PASS_SECRET\napi_key=KEY_SECRET\nhttps://host/path?signature=SIGNED_SECRET\nC:\\Users\\PROFILE_SECRET\\file\n']}, {}]);
  await f.run(); const logs = JSON.stringify(f.logs);
  for (const secret of ['SECRET', 'private', 'PROFILE_SECRET']) assert.ok(!logs.includes(secret), logs);
  assert.match(logs, /HTTP Error 403/);
});
test('timeout kills process and does not retry', async () => {
  const f = fixture(['hang']); await assert.rejects(f.run({timeoutMs: 5}), /délai/); assert.equal(f.calls.length, 1);
});
test('pre-aborted download does not spawn', async () => {
  const f = fixture([]); await assert.rejects(f.run({ signal: AbortSignal.abort() }), {name:'AbortError'}); assert.equal(f.calls.length, 0);
});
test('abort during download stops retries', async () => {
  const f = fixture(['hang']); const controller = new AbortController();
  const promise = f.run({signal:controller.signal}); controller.abort();
  await assert.rejects(promise, {name:'AbortError'}); assert.equal(f.calls.length, 1);
});
test('missing executable is clear', async () => {
  const f = fixture([{error: 'ENOENT'}]); await assert.rejects(f.run(), /yt-dlp introuvable/);
});
test('invalid browser value is not exposed', async () => {
  const f = fixture([]); await assert.rejects(f.run({browser:'SECRET'}), /doit valoir chrome ou firefox/); assert.equal(f.calls.length, 0);
});
