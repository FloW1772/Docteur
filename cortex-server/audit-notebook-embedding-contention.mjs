// Small, isolated real-Ollama comparison: article indexing while Notebook is idle vs explicitly importing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = 3947;
const BASE = `http://127.0.0.1:${PORT}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-notebook-contention-'));
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), SQLITE_PATH: path.join(tempRoot, 'cortex.sqlite'), LANCEDB_PATH: path.join(tempRoot, 'cortex.lance'), LOG_FILE: path.join(tempRoot, 'cortex.log'), DOCTEUR_NO_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', value => { output = (output + value).slice(-10_000); });
server.stderr.on('data', value => { output = (output + value).slice(-10_000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, route, body) {
  const started = Date.now();
  const response = await fetch(`${BASE}${route}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${response.status} ${json.error ?? ''}`);
  return { elapsedMs: Date.now() - started, json };
}
async function waitUp() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) return; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error(`boot timeout ${output.slice(-500)}`);
}
async function stop() {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(5_000)]);
}
const indexPayload = suffix => ({ id: crypto.randomUUID(), kind: 'link', title: `Index ${suffix}`, content: `Texte d'indexation ${suffix}. ` + 'Contexte factuel local et déterministe. '.repeat(80), metadata: {} });
const notebookText = Array.from({ length: 24 }, (_, i) => `Section ${i + 1}. ` + 'Ce document Notebook contient des faits locaux destinés au test de concurrence des embeddings. '.repeat(16)).join('\n\n');

const report = { tempRoot };
try {
  await waitUp();
  report.idleIndex = await api('POST', '/api/index', indexPayload('idle'));
  const notebook = await api('POST', '/api/notebooks', { title: 'Contention audit' });
  const importStarted = Date.now();
  const importPromise = api('POST', `/api/notebooks/${notebook.json.id}/documents/import?wait=1`, { title: 'Import concurrent', text: notebookText });
  await sleep(10);
  const concurrentIndex = await api('POST', '/api/index', indexPayload('concurrent'));
  const imported = await importPromise;
  report.concurrent = {
    articleIndex: concurrentIndex,
    notebookImport: imported,
    wallMs: Date.now() - importStarted,
  };
} finally {
  await stop();
}
console.log(JSON.stringify(report, null, 2));
