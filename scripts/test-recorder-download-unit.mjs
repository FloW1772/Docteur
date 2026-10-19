// [REC-DL-1] — unit tests of the download contracts, HTTP port and native-download helper (Node type stripping).
// No browser, no network: fetch and document are fakes that record every call.
// Usage: node --test scripts/test-recorder-download-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canDownload, downloadStateForError, DOWNLOAD_LABEL, isRecordingId } from '../src/lib/recorder/recorder-contracts.ts';
import { createHttpRecorderPort, RECORDER_ERROR_HEADER } from '../src/lib/recorder/http-port.ts';
import { startNativeDownload } from '../src/lib/recorder/native-download.ts';

const ID = `rec_${'0123456789abcdef'.repeat(2)}`;
const forbiddenBody = () => { throw new Error('the download body must never be read in the renderer'); };
function fakeFetch(status = 200, headers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), blob: forbiddenBody, arrayBuffer: forbiddenBody, text: forbiddenBody, json: forbiddenBody, body: null };
  };
  fn.calls = calls;
  return fn;
}

test('READY-only rule, labels, error mapping (unknown code = error, never success)', () => {
  assert.equal(canDownload({ recordingId: ID, status: 'READY' }), true);
  for (const s of ['PREPARING', 'RECORDING', 'FINALIZING', 'FAILED', 'CANCELLED', 'DELETING', 'MISSING', 'ready', undefined]) assert.equal(canDownload({ recordingId: ID, status: s }), false, String(s));
  for (const bad of ['../x', 'C:\\x', `rec_${'A'.repeat(32)}`, '', null]) assert.equal(canDownload({ recordingId: bad, status: 'READY' }), false, String(bad));
  assert.equal(canDownload(null), false);
  assert.deepEqual(DOWNLOAD_LABEL, { IDLE: 'Télécharger', CHECKING: 'Téléchargement…', STARTED: 'Téléchargement lancé', UNAVAILABLE: 'Indisponible', MISSING: 'Fichier manquant', ERROR: 'Erreur' });
  assert.equal(/téléchargé\b/i.test(Object.values(DOWNLOAD_LABEL).join(' ')), false, 'never claims "téléchargé"');
  assert.deepEqual(['RECORDING_FILE_MISSING', 'RECORDING_NOT_READY', 'RECORDING_NOT_FOUND', 'FILE_CHANGED', 'ROOT_ESCAPE', 'HTTP_500', undefined].map(downloadStateForError),
    ['MISSING', 'UNAVAILABLE', 'UNAVAILABLE', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
});

test('http port: the download URL carries the recordingId only; a path / key / file name is refused before any request', () => {
  const f = fakeFetch();
  const port = createHttpRecorderPort({ baseUrl: 'http://127.0.0.1:3001/', fetchImpl: f });
  assert.equal(port.downloadUrl(ID), `http://127.0.0.1:3001/api/recorder/recordings/${ID}/download`);
  for (const bad of ['../../outside', '..\\..\\x', 'C:\\Users\\x\\video.webm', '\\\\server\\share\\x', 'file:///C:/x', `files/${ID}.webm`, `${ID}?path=C:\\x`, `${ID}/../x`, `rec_${'a'.repeat(31)}`, '%2e%2e', '']) {
    assert.throws(() => port.downloadUrl(bad), (e) => e.code === 'INVALID_RECORDING_ID', bad);
  }
  assert.equal(f.calls.length, 0, 'nothing sent for a refused id');
  assert.equal(isRecordingId(ID), true);
});

test('http port: checkDownload is a HEAD (no body read); refusals carry the server code from the header', async () => {
  const ok = fakeFetch(200, { 'content-length': '123' });
  await createHttpRecorderPort({ baseUrl: 'http://127.0.0.1:3001', fetchImpl: ok }).checkDownload(ID);
  assert.deepEqual(ok.calls.map(c => [c.method, c.url, c.body]), [['HEAD', `http://127.0.0.1:3001/api/recorder/recordings/${ID}/download`, undefined]]);
  for (const [status, code, expected] of [[404, 'RECORDING_FILE_MISSING', 'RECORDING_FILE_MISSING'], [409, 'FILE_CHANGED', 'FILE_CHANGED'], [409, 'RECORDING_NOT_READY', 'RECORDING_NOT_READY'], [500, null, 'HTTP_500']]) {
    const f = fakeFetch(status, code ? { [RECORDER_ERROR_HEADER]: code } : {});
    await assert.rejects(createHttpRecorderPort({ baseUrl: 'http://x', fetchImpl: f }).checkDownload(ID), (e) => e.code === expected, `${status} ${code}`);
  }
  const down = async () => { throw new TypeError('network down'); };
  await assert.rejects(createHttpRecorderPort({ baseUrl: 'http://x', fetchImpl: down }).checkDownload(ID), (e) => e.code === 'UPLOAD_FAILED');
});

test('native download: one hidden <a> with the URL, clicked once and removed; no fetch, no blob', () => {
  const events = [];
  const anchor = { style: {}, click() { events.push(['click', this.href, this.download, this.rel]); }, remove() { events.push(['remove']); } };
  const doc = { createElement(tag) { events.push(['create', tag]); return anchor; }, body: { appendChild(el) { events.push(['append', el === anchor]); } } };
  const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; };
  try { startNativeDownload(`http://127.0.0.1:3001/api/recorder/recordings/${ID}/download`, doc); } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(events, [['create', 'a'], ['append', true], ['click', `http://127.0.0.1:3001/api/recorder/recordings/${ID}/download`, '', 'noopener'], ['remove']]);
  assert.equal(fetched, 0);
  assert.equal(anchor.style.display, 'none');
});

test('static: the download path never buffers the file in the renderer (no blob / arrayBuffer / FileReader / object URL) and never names a path', () => {
  for (const f of ['src/lib/recorder/native-download.ts', 'src/components/recorder/RecordingDownloadButton.tsx', 'src/lib/recorder/http-port.ts']) {
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.equal(/\.blob\s*\(|arrayBuffer\s*\(|FileReader|createObjectURL|readAsDataURL/.test(src), false, f);
    assert.equal(/storageKey|storage_key|absolutePath|relativePath|[?&]path=|file:\/\//.test(src), false, f);
  }
  const btn = fs.readFileSync('src/components/recorder/RecordingDownloadButton.tsx', 'utf8');
  assert.ok(/if \(!canDownload\(recording\)\) return null;/.test(btn), 'the button renders only for a READY recording');
  assert.equal(/useEffect/.test(btn), false, 'no effect: a download can only start from the click handler');
});
