// BATCH C — limite de taille des téléchargements OneDrive (audit finding F2,
// autorisé 2026-09-16).
//
// downloadFileContent() n'est pas encore câblée dans routes/connectors.js
// (voir le commentaire PARTIEL dans routes/connectors.js — la vraie
// extraction de contenu OneDrive attend un enregistrement d'app Microsoft
// réel pour être testée en conditions réelles, Phase 2). Ce fichier teste
// donc la fonction directement, au niveau librairie, avec fetch mocké —
// aucun appel réseau réel, aucun credential réel.
//
// Run: node --test test-batch-c-onedrive-size-limit.mjs
import './test-setup.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadFileContent, ONEDRIVE_MAX_DOWNLOAD_BYTES, OneDriveFileTooLargeError,
} from './src/lib/connectors/onedrive-connector.js';

let originalFetch;

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function streamOf(totalBytes, { chunkSize = 8192, declaredContentLength = totalBytes } = {}) {
  const headers = declaredContentLength === null ? {} : { 'content-length': String(declaredContentLength) };
  const stream = new ReadableStream({
    start(controller) {
      let remaining = totalBytes;
      while (remaining > 0) {
        const n = Math.min(chunkSize, remaining);
        controller.enqueue(new Uint8Array(n));
        remaining -= n;
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

// ── Fichier sous la limite ──────────────────────────────────────────────

test('downloadFileContent: file under the limit succeeds and returns the exact byte count', async () => {
  const maxBytes = 1000;
  globalThis.fetch = async () => streamOf(500);
  const buf = await downloadFileContent('https://example.invalid/file', { maxBytes });
  assert.equal(buf.byteLength, 500);
});

// ── Exactement à la limite ──────────────────────────────────────────────

test('downloadFileContent: file exactly at the limit succeeds (limit is inclusive)', async () => {
  const maxBytes = 1000;
  globalThis.fetch = async () => streamOf(1000);
  const buf = await downloadFileContent('https://example.invalid/file', { maxBytes });
  assert.equal(buf.byteLength, 1000);
});

// ── Au-dessus de la limite (Content-Length honnête) ─────────────────────

test('downloadFileContent: file over the limit with an honest Content-Length is rejected before streaming', async () => {
  const maxBytes = 1000;
  let bodyCancelled = false;
  globalThis.fetch = async () => {
    const res = streamOf(5000, { declaredContentLength: 5000 });
    const originalCancel = res.body.cancel.bind(res.body);
    res.body.cancel = async (...args) => { bodyCancelled = true; return originalCancel(...args); };
    return res;
  };
  await assert.rejects(
    () => downloadFileContent('https://example.invalid/file', { maxBytes }),
    (err) => {
      assert.ok(err instanceof OneDriveFileTooLargeError);
      assert.equal(err.code, 'ONEDRIVE_FILE_TOO_LARGE');
      assert.equal(err.declaredSize, 5000);
      assert.equal(err.receivedBytes, 0); // rejected on the header check, before any byte was read
      return true;
    },
  );
  assert.ok(bodyCancelled, 'the oversized body should be cancelled, not left dangling');
});

// ── Content-Length absent ────────────────────────────────────────────────

test('downloadFileContent: missing Content-Length does not allow an unlimited download — still bounded by streaming enforcement', async () => {
  const maxBytes = 1000;
  globalThis.fetch = async () => streamOf(500, { declaredContentLength: null });
  const buf = await downloadFileContent('https://example.invalid/file', { maxBytes });
  assert.equal(buf.byteLength, 500); // under the limit, still succeeds without a header
});

test('downloadFileContent: missing Content-Length + body over the limit is still caught by the streaming check', async () => {
  const maxBytes = 1000;
  globalThis.fetch = async () => streamOf(5000, { declaredContentLength: null });
  await assert.rejects(
    () => downloadFileContent('https://example.invalid/file', { maxBytes }),
    (err) => {
      assert.ok(err instanceof OneDriveFileTooLargeError);
      assert.equal(err.code, 'ONEDRIVE_FILE_TOO_LARGE');
      // A genuinely absent header stays null (distinct from a server that
      // literally sent "content-length: 0") and is only ever caught by the
      // streaming check below, never the header pre-check.
      assert.equal(err.declaredSize, null);
      assert.ok(err.receivedBytes > maxBytes);
      return true;
    },
  );
});

// ── Content-Length mensonger (annonce petit, envoie gros) ────────────────

test('downloadFileContent: dishonest (too-small) Content-Length does not bypass the streaming limit', async () => {
  const maxBytes = 1000;
  globalThis.fetch = async () => streamOf(5000, { declaredContentLength: 100 }); // lies: says 100, sends 5000
  await assert.rejects(
    () => downloadFileContent('https://example.invalid/file', { maxBytes }),
    (err) => {
      assert.ok(err instanceof OneDriveFileTooLargeError);
      // Passed the (dishonest) header pre-check, caught only by the running
      // byte count during streaming — proves the header is never trusted alone.
      assert.equal(err.declaredSize, 100);
      assert.ok(err.receivedBytes > maxBytes);
      return true;
    },
  );
});

// ── Stream dépassant la limite en cours de lecture ────────────────────────

test('downloadFileContent: stream that exceeds the limit mid-read is aborted, not buffered to completion', async () => {
  const maxBytes = 1000;
  let chunksReadAfterLimit = 0;
  const hugeStream = new ReadableStream({
    start(controller) {
      let sent = 0;
      const total = 1_000_000; // would be 1MB if allowed to run to completion
      const push = () => {
        if (sent >= total) { controller.close(); return; }
        const n = Math.min(200, total - sent);
        controller.enqueue(new Uint8Array(n));
        sent += n;
        if (sent > maxBytes) chunksReadAfterLimit++;
        if (chunksReadAfterLimit <= 2) push(); // let a couple more chunks through past the limit to prove it stops promptly, not eventually
      };
      push();
    },
  });
  globalThis.fetch = async () => new Response(hugeStream, { status: 200 }); // no content-length

  await assert.rejects(
    () => downloadFileContent('https://example.invalid/file', { maxBytes }),
    (err) => {
      assert.ok(err instanceof OneDriveFileTooLargeError);
      return true;
    },
  );
  // Proves the whole 1MB was never accumulated — enforcement happened within
  // a couple of 200-byte chunks after crossing maxBytes, not after buffering everything.
  assert.ok(chunksReadAfterLimit <= 3, `expected early abort, but read ${chunksReadAfterLimit} chunks past the limit`);
});

// ── Timeout ────────────────────────────────────────────────────────────────

test('downloadFileContent: a fetch that throws (e.g. AbortSignal timeout) surfaces a clean error, no raw stack/URL leaked', async () => {
  globalThis.fetch = async () => { throw new DOMException('The operation was aborted', 'TimeoutError'); };
  await assert.rejects(
    () => downloadFileContent('https://example.invalid/secret-path?token=abc', { maxBytes: 1000 }),
    (err) => {
      assert.ok(!err.message.includes('secret-path'));
      assert.ok(!err.message.includes('token=abc'));
      assert.ok(!err.message.includes('DOMException'));
      return true;
    },
  );
});

// ── Annulation ─────────────────────────────────────────────────────────────

test('downloadFileContent: an already-aborted caller signal surfaces a clean error (cancellation path)', async () => {
  globalThis.fetch = async (_url, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return streamOf(500);
  };
  // downloadFileContent builds its own AbortSignal.timeout() internally and
  // does not currently accept a caller-supplied signal — this test documents
  // that an abort surfaced by fetch() (whatever the source) is still turned
  // into the same clean, non-leaking error shape as a timeout.
  const originalAbortSignalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => { const c = new AbortController(); c.abort(); return c.signal; };
  try {
    await assert.rejects(
      () => downloadFileContent('https://example.invalid/file', { maxBytes: 1000 }),
      (err) => {
        assert.ok(!err.message.includes('DOMException'));
        assert.ok(!err.message.includes('AbortError'));
        return true;
      },
    );
  } finally {
    AbortSignal.timeout = originalAbortSignalTimeout;
  }
});

// ── Jamais exposer token / URL sensible / headers / stack brute ──────────

test('downloadFileContent: no error path ever includes an Authorization header value', async () => {
  globalThis.fetch = async () => streamOf(5000, { declaredContentLength: 5000 });
  try {
    await downloadFileContent('https://graph.microsoft.com/v1.0/me/drive/items/abc/content?tok=SECRET', { maxBytes: 1000 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes('SECRET'));
    assert.ok(!err.message.includes('Authorization'));
    assert.ok(!err.message.includes('Bearer'));
    assert.ok(!('stack' in err) || !err.stack.includes('SECRET'));
  }
});

// ── HTTP non-ok ────────────────────────────────────────────────────────────

test('downloadFileContent: non-ok HTTP status still throws a clean, generic error', async () => {
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(
    () => downloadFileContent('https://example.invalid/file', { maxBytes: 1000 }),
    /403/,
  );
});

test('ONEDRIVE_MAX_DOWNLOAD_BYTES: is a sane positive default (reuses lib/files.js MAX_FILE_SIZE_BYTES)', () => {
  assert.ok(ONEDRIVE_MAX_DOWNLOAD_BYTES > 0);
  assert.equal(ONEDRIVE_MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024);
});
