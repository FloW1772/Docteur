// NB-7 — REAL AI-export validator (privacy-preserving). Use ONLY on an export the user explicitly provides.
//   node nb7-validate-real-export.mjs <path-to-export.zip|.json> [--declared CHATGPT|GEMINI|CLAUDE]
// It runs the NB-4 adapter PREVIEW in a throw-away temp database (nothing is imported, nothing is stored, no network, no LLM) and prints ONLY:
// provider detected, verified-by-structure flag, file count, conversation count, message count, invalid count, blocked entries, PASS/FAIL.
// It never prints a prompt, a message, a title, a name or a secret value. A PASS here is what allows an adapter to stop being SYNTHETIC_ONLY;
// without a provided export the status stays NOT_RUN / SYNTHETIC_ONLY. It refuses directories and never searches the disk.
import './test-setup.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, createNotebook } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createAiHistoryService } from './src/lib/notebook-ai-history.js';

export async function validateExport(filePath, { declared } = {}) {
  const stat = fs.statSync(filePath); if (!stat.isFile()) throw new Error('un fichier est attendu (jamais un dossier)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb7-export-'));
  try {
    initSqlite(path.join(tmp, 'v.db'));
    const doc = createNotebookDocumentService({ embedText: async () => [0], embeddingModel: 'x', vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath: path.join(tmp, 'x.lance'), localComplete: async () => '' });
    const ai = createAiHistoryService(doc, { localComplete: async () => '', localModelAvailable: async () => false });
    createNotebook({ id: 'nb-validate', title: 'validate' });
    const r = await ai.preview({ notebookId: 'nb-validate', path: filePath, filename: path.basename(filePath), declaredProvider: declared, secretPolicy: 'redact' });
    const c = r.counts ?? {};
    const pass = r.adapter !== undefined && c.conversations > 0 && c.messages > 0 && c.invalid === 0;
    return { provider: r.provider, providerVerifiedByStructure: r.providerVerified === true, adapter: r.adapter, files: c.files ?? null, conversations: c.conversations ?? 0, messages: c.messages ?? 0, invalid: c.invalid ?? 0, blockedEntries: c.blockedEntries ?? 0, secretFindingKinds: (r.findings ?? []).map(f => f.kind), status: pass ? 'PASS' : 'FAIL' };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const file = process.argv[2]; const di = process.argv.indexOf('--declared');
  if (!file) { console.log(JSON.stringify({ status: 'NOT_RUN', reason: 'no export provided' })); process.exit(0); }
  try { console.log(JSON.stringify(await validateExport(file, { declared: di > 0 ? process.argv[di + 1] : undefined }))); } catch (e) { console.log(JSON.stringify({ status: 'FAIL', error: String(e.message).slice(0, 120) })); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
