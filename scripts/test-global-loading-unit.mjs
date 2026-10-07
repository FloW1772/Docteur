// Global Loading V1 — unit tests of the central long-operation model (src/lib/loading/operation.ts,
// Node type stripping) + static audit of the wired operations.
// Usage: node --test scripts/test-global-loading-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  IDLE_OPERATION, OPERATION_POLICIES, SLOW_MESSAGE, describeOperation, elapsedMs, errorMessage, formatElapsed,
  isSlow, operationReducer, progressPercent,
} from '../src/lib/loading/operation.ts';

const start = (state = IDLE_OPERATION, at = 1_000) => operationReducer(state, { type: 'start', label: 'Capture', step: 'Récupération…', at });

test('lifecycle: start → step → progress → success, attempt counter', () => {
  let s = start();
  assert.equal(s.status, 'running');
  assert.equal(s.step, 'Récupération…');
  assert.equal(s.attempt, 1);
  s = operationReducer(s, { type: 'step', step: 'Analyse…' });
  s = operationReducer(s, { type: 'progress', progress: { current: 2, total: 4 } });
  assert.equal(s.step, 'Analyse…');
  assert.deepEqual(s.progress, { current: 2, total: 4 });
  s = operationReducer(s, { type: 'succeed', at: 5_000 });
  assert.equal(s.status, 'success');
  assert.equal(elapsedMs(s, 99_999), 4_000, 'elapsed frozen at the end');
  assert.equal(start(s).attempt, 2);
});

test('every end state is final: a late success/step cannot overwrite timeout, error or cancel', () => {
  for (const end of [{ type: 'timeout', at: 2 }, { type: 'fail', error: 'boom', at: 2 }, { type: 'cancel', at: 2 }]) {
    const ended = operationReducer(start(), end);
    for (const late of [{ type: 'succeed', at: 3 }, { type: 'step', step: 'x' }, { type: 'progress', progress: { current: 1, total: 1 } }, { type: 'fail', error: 'later', at: 3 }]) {
      assert.deepEqual(operationReducer(ended, late), ended, `${end.type} then ${late.type}`);
    }
  }
  assert.equal(operationReducer(IDLE_OPERATION, { type: 'succeed', at: 1 }).status, 'idle');
});

test('error keeps the message; empty message gets a readable fallback; reset returns to idle', () => {
  assert.equal(operationReducer(start(), { type: 'fail', error: 'HTTP 503', at: 2 }).error, 'HTTP 503');
  assert.equal(operationReducer(start(), { type: 'fail', error: '', at: 2 }).error, 'Erreur inconnue');
  const reset = operationReducer(operationReducer(start(), { type: 'cancel', at: 2 }), { type: 'reset' });
  assert.equal(reset.status, 'idle');
  assert.equal(reset.attempt, 1);
});

test('known vs unknown progress', () => {
  assert.equal(progressPercent(null), null);
  assert.equal(progressPercent({ current: 0, total: 0 }), null);
  assert.equal(progressPercent({ current: Number.NaN, total: 3 }), null);
  assert.equal(progressPercent({ current: 1, total: 3 }), 33);
  assert.equal(progressPercent({ current: 5, total: 3 }), 100);
  assert.equal(progressPercent({ current: -1, total: 3 }), 0);
});

test('elapsed formatting and the "slower than expected" threshold', () => {
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(59_999), '59 s');
  assert.equal(formatElapsed(65_000), '1 min 05 s');
  const s = start(IDLE_OPERATION, 0);
  const policy = OPERATION_POLICIES.articleCapture;
  assert.equal(isSlow(s, policy, policy.slowAfterMs - 1), false);
  assert.equal(isSlow(s, policy, policy.slowAfterMs), true);
  assert.equal(describeOperation(s, policy, policy.slowAfterMs), `Récupération… — ${SLOW_MESSAGE}`);
});

test('timeout message says when the server may still finish the work', () => {
  const t = operationReducer(start(), { type: 'timeout', at: 2 });
  assert.match(describeOperation(t, OPERATION_POLICIES.imageGeneration, 3), /délai dépassé \(3 min 20 s\)\. Le serveur a peut-être terminé/);
  assert.doesNotMatch(describeOperation(t, OPERATION_POLICIES.pdfExport, 3), /peut-être/);
  assert.match(describeOperation(operationReducer(start(), { type: 'cancel', at: 2 }), OPERATION_POLICIES.pdfExport, 3), /annulé/);
});

test('abort/timeout errors are translated, other errors keep their message', () => {
  const abort = new Error('This operation was aborted'); abort.name = 'AbortError';
  assert.equal(errorMessage(abort), 'La requête a été interrompue (délai réseau dépassé).');
  assert.equal(errorMessage(new Error('ComfyUI indisponible')), 'ComfyUI indisponible');
  assert.equal(errorMessage('texte'), 'texte');
  assert.match(errorMessage(abort, OPERATION_POLICIES.imageGeneration), /Le serveur a peut-être terminé en arrière-plan\./);
  assert.doesNotMatch(errorMessage(abort, OPERATION_POLICIES.pdfExport), /peut-être/);
});

test('policies: finite timeout after the slow threshold; one global operation; cancel only where real', () => {
  for (const [kind, p] of Object.entries(OPERATION_POLICIES)) {
    assert.ok(Number.isFinite(p.timeoutMs) && p.timeoutMs > p.slowAfterMs, `${kind}: finite timeout > slow threshold (no infinite spinner)`);
    assert.ok(['local', 'modal', 'global'].includes(p.scope), kind);
  }
  assert.deepEqual(Object.entries(OPERATION_POLICIES).filter(([, p]) => p.scope === 'global').map(([k]) => k), ['backupImport']);
  assert.deepEqual(Object.entries(OPERATION_POLICIES).filter(([, p]) => p.cancellable).map(([k]) => k), ['articleCapture', 'mediaReader', 'mediaStudioImport', 'mediaStudioExport'], 'cancel only where an AbortSignal really stops the load (capture request, Media Reader close, Media Studio upload abort / FFmpeg tree kill)');
  assert.equal(OPERATION_POLICIES.chatReply.retryable, false, 'a resend could duplicate the stored user message');
  assert.equal(OPERATION_POLICIES.backupImport.retryable, false);
  // The capture modal waits for a request bounded by DEEP_CAPTURE_TIMEOUT_MS (5 min): our limit is above it.
  const pipeline = fs.readFileSync('src/lib/capturePipeline.ts', 'utf8');
  const expr = pipeline.match(/DEEP_CAPTURE_TIMEOUT_MS\s*=\s*([^;]+);/)?.[1]?.replace(/_/g, '') ?? '';
  assert.match(expr, /^[\d\s*]+$/, 'plain product of numbers');
  const bound = expr.split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
  assert.equal(bound, 300_000);
  assert.ok(OPERATION_POLICIES.articleCapture.timeoutMs > bound);
});

test('static audit: wired operations use the central model, no bare spinner left in them', () => {
  const wired = {
    'src/components/modals/ImageGeneratorModal.tsx': "useLongOperation('imageGeneration')",
    'src/components/modals/VisionAnalyzeModal.tsx': "useLongOperation('visionAnalysis')",
    'src/components/modals/PdfExportModal.tsx': "useLongOperation('pdfExport')",
    'src/components/modals/ConversationModal.tsx': "useLongOperation('chatReply')",
    'src/components/modals/BackupModal.tsx': "useLongOperation('backupImport')",
  };
  for (const [file, marker] of Object.entries(wired)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(src.includes(marker), `${file} uses ${marker}`);
    assert.doesNotMatch(src, /setGenerating\(|setVisionLoading\(|setLoading\(true\)/, `${file}: no ad-hoc boolean loading left`);
  }
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  assert.ok(app.includes('OPERATION_POLICIES.articleCapture') && app.includes('<OperationProgress'), 'capture modal uses the progress panel');
  const css = fs.readFileSync('src/styles/globals.css', 'utf8');
  const block = css.slice(css.indexOf('[Global Loading V1]'));
  assert.match(block, /prefers-reduced-motion: reduce[\s\S]*\.dl-spinner \{ animation: none;/);
});

test('[Browser Media Bridge V1] the Media Reader loads under the central policy (same thresholds, one system)', async () => {
  const media = await import('../src/lib/media/media-resource.ts');
  assert.equal(OPERATION_POLICIES.mediaReader.slowAfterMs, media.SLOW_AFTER_MS);
  assert.equal(OPERATION_POLICIES.mediaReader.timeoutMs, media.LOAD_TIMEOUT_MS);
  const reader = fs.readFileSync('src/components/media/MediaReader.tsx', 'utf8');
  assert.ok(reader.includes('OPERATION_POLICIES.mediaReader') && reader.includes('<OperationProgress'), 'reader displays its load with the F2 panel');
  assert.doesNotMatch(reader, /Loader2/, 'no second, ad-hoc spinner left in the reader');
});
