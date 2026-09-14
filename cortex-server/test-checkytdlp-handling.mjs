import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the exact call-site shape in server.js (checkYtDlp().then(...).catch(...))
// without booting the whole server — isolates the promise-handling contract itself.
function runCheckYtDlpHandler(checkYtDlpMock, logger) {
  return checkYtDlpMock().then(v => {
    if (v) logger.info({ version: v }, 'yt-dlp trouvé');
    else    logger.warn('yt-dlp introuvable — téléchargement vidéo désactivé. Installe avec : winget install yt-dlp');
  }).catch(err => {
    logger.warn({ err: err?.message }, 'yt-dlp check échouée de façon inattendue — téléchargement vidéo probablement désactivé');
  });
}

test('checkYtDlp available: logs info with version, no warning, no rejection', async () => {
  const calls = { info: [], warn: [] };
  const logger = { info: (...a) => calls.info.push(a), warn: (...a) => calls.warn.push(a) };
  await runCheckYtDlpHandler(async () => '2024.12.06', logger);
  assert.equal(calls.info.length, 1);
  assert.equal(calls.warn.length, 0);
});

test('checkYtDlp absent (resolves null): logs a warning, no rejection reaches the caller', async () => {
  const calls = { info: [], warn: [] };
  const logger = { info: (...a) => calls.info.push(a), warn: (...a) => calls.warn.push(a) };
  await runCheckYtDlpHandler(async () => null, logger);
  assert.equal(calls.info.length, 0);
  assert.equal(calls.warn.length, 1);
});

test('checkYtDlp rejects unexpectedly: caught by .catch, produces a warning, never an unhandled rejection', async () => {
  const calls = { info: [], warn: [] };
  const logger = { info: (...a) => calls.info.push(a), warn: (...a) => calls.warn.push(a) };

  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await runCheckYtDlpHandler(async () => { throw new Error('simulated spawn failure'); }, logger);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0][1] ?? '', /inattendue/);
  assert.equal(unhandled, false, 'must never surface as an unhandled promise rejection');
});
