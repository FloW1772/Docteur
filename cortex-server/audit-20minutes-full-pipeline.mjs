// Real A/B extraction + local AI + SQLite save + embedding + LanceDB proof.
// All persistence is isolated in a fresh OS temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from '@lancedb/lancedb';

const PORT = 3946;
const BASE = `http://127.0.0.1:${PORT}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-20minutes-audit-'));
const sqlitePath = path.join(tempRoot, 'cortex.sqlite');
const lancePath = path.join(tempRoot, 'cortex.lance');
const logPath = path.join(tempRoot, 'cortex.log');
const urls = [
  'https://www.20minutes.fr/monde/italie/4242099-20260904-recette-gouvernement-giorgia-meloni-devient-plus-long-italie-apres-guerre',
  'https://www.20minutes.fr/monde/4239952-20260819-portugal-interdit-port-voile-integral',
];

const serverStarted = Date.now();
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    SQLITE_PATH: sqlitePath,
    LANCEDB_PATH: lancePath,
    LOG_FILE: logPath,
    DOCTEUR_NO_BROWSER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-20_000); });
server.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-20_000); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${json.error ?? 'unknown error'}`);
  return json;
}
async function waitForServer(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) return Date.now() - serverStarted; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error(`server boot timeout: ${serverOutput.slice(-1_000)}`);
}
async function stopServer() {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    sleep(5_000),
  ]);
}

const report = { tempRoot, bootMs: null, results: [] };
try {
  report.bootMs = await waitForServer();
  for (const [index, url] of urls.entries()) {
    const captureStarted = Date.now();
    const capture = await request('POST', '/api/capture/deep', { url, captureImages: false });
    if (capture.fallback || !capture.child) throw new Error(`article ${index + 1} fallback: ${capture.reason ?? 'unknown'}`);

    const id = crypto.randomUUID();
    const now = Date.now();
    let page = {
      id,
      title: capture.child.title,
      kind: capture.child.kind,
      blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: capture.child.content }],
      links: [],
      metadata: { ...(capture.child.metadata ?? {}), captureStatus: 'INDEXING' },
      createdAt: now,
      updatedAt: now,
    };
    const saveStarted = Date.now();
    await request('PUT', `/api/neuron/${id}`, { page });
    const saveMs = Date.now() - saveStarted;
    const indexResult = await request('POST', '/api/index', {
      id,
      kind: page.kind,
      title: page.title,
      content: capture.child.content,
      metadata: page.metadata,
      captureId: capture.captureId,
    });
    page = { ...page, metadata: { ...page.metadata, captureStatus: 'READY' }, updatedAt: Date.now() };
    const readyStarted = Date.now();
    await request('PUT', `/api/neuron/${id}`, { page });
    const readyMs = Date.now() - readyStarted;
    const saved = await request('GET', `/api/neuron/${id}`);
    report.results.push({
      article: index === 0 ? 'A' : 'B',
      url,
      id,
      captureMs: Date.now() - captureStarted,
      fallback: capture.fallback,
      title: capture.child.title,
      wordCount: capture.child.metadata?.word_count ?? 0,
      images: capture.child.metadata?.images?.length ?? 0,
      extraction: capture.extraction,
      timings: capture.timings,
      saveMs,
      embeddingMs: indexResult.embedding_ms,
      lanceDbMs: indexResult.lancedb_ms,
      indexLatencyMs: indexResult.latency_ms,
      readyMs,
      persistedStatus: saved.page?.metadata?.captureStatus ?? saved.metadata?.captureStatus ?? null,
    });
  }
} finally {
  await stopServer();
}

try {
  const lance = await connect(lancePath);
  const table = await lance.openTable('neurons');
  const ids = report.results.map(item => item.id);
  const rows = await table.query().where(`id IN (${ids.map(id => `'${id}'`).join(',')})`).toArray();
  report.lanceRows = rows.length;
} catch (error) {
  report.lanceRows = 0;
  report.lanceError = error.message;
}

console.log(JSON.stringify(report, null, 2));
