// NB-7 — FREEZE manifest for Notebook + AI History + Docteur Memory (+ main-chat memory integration + local API guard).
//   node nb7-freeze-manifest.mjs            write ../reports/nb7-freeze-manifest.json (sha256 of each file, line endings normalised to LF)
//   node nb7-freeze-manifest.mjs --verify   compare the working tree with the manifest; exit 1 and list every drifted file
// "FROZEN" = any later change to a listed file is a NEW mission, and --verify makes that visible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '..'); const OUT = path.join(REPO, 'reports', 'nb7-freeze-manifest.json');
const rel = (p) => path.relative(REPO, p).replaceAll('\\', '/');
const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)) : []);
export function frozenFiles() {
  return [
    ...list(path.join(HERE, 'src', 'lib'), /^(notebook-.*|chat-memory|local-request-guard|local-api-policy)\.js$/),
    ...list(path.join(HERE, 'src', 'routes'), /^notebook.*\.js$/),
    ...list(path.join(REPO, 'src', 'components', 'modals'), /^Notebook.*\.tsx$/),
    ...list(path.join(REPO, 'src', 'components', 'console'), /^ChatMemoryControls\.tsx$/),
    ...list(HERE, /^(test-nb[2-7]-.*|nb[2-7]-.*|nb7-.*)\.(mjs|cjs)$/),
    ...list(path.join(REPO, 'scripts'), /^(test-notebook-.*|notebook-docs-harness|test-chat-memory-browser)\.(mjs|jsx)$/),
    ...list(path.join(REPO, 'reports'), /^DOCTEUR_NOTEBOOK_NB[1-7]_.*\.md$/),
  ].filter(f => fs.statSync(f).isFile()).sort();
}
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--verify')) {
    const m = JSON.parse(fs.readFileSync(OUT, 'utf8')); const drift = [];
    for (const [f, h] of Object.entries(m.files)) { const p = path.join(REPO, f); if (!fs.existsSync(p)) drift.push(`MISSING ${f}`); else if (hash(p) !== h) drift.push(`CHANGED ${f}`); }
    for (const f of frozenFiles().map(rel)) if (!(f in m.files) && !/^reports\/DOCTEUR_NOTEBOOK_NB7_/.test(f)) drift.push(`NEW ${f}`);
    console.log(JSON.stringify({ frozen: m.frozenAt, files: Object.keys(m.files).length, drift })); process.exit(drift.length ? 1 : 0);
  }
  const files = {}; for (const f of frozenFiles()) if (!/^reports\/DOCTEUR_NOTEBOOK_NB7_/.test(rel(f))) files[rel(f)] = hash(f);
  fs.writeFileSync(OUT, JSON.stringify({ frozenAt: new Date().toISOString(), scope: 'Notebook (NB-1..NB-7) + AI History + Docteur Memory + main-chat memory integration + local API guard', note: 'sha256 of LF-normalised content; the NB-7 report itself is excluded (it embeds the result)', files }, null, 1));
  console.log(`manifest: ${Object.keys(files).length} files`);
}
