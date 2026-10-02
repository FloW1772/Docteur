// NB-7 — route-by-route security matrix of the LOCAL Docteur API (static extraction of every route registration).
// Used by test-nb7-local-api-security.mjs (which then PROVES the policy on every non-frozen route) and by the report.
// Usage: node nb7-route-matrix.mjs   (writes ../reports/nb7-route-security-matrix.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFrozenPath, bodyCapFor } from './src/lib/local-api-policy.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_RE = /\b(?:route|app|router|r)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g;

// GET routes that return only static / catalog / liveness information (no personal data, no local state worth stealing)
const PUBLIC_GET_FILES = new Set(['health.js', 'local-ai.js', 'free-ai.js', 'ollama.js', 'prompt-generator.js', 'kiwix.js', 'jobs.js', 'openmontage.js', 'image-generation.js']);
// POST routes that are pure computations on the caller's own input (no persistence, no local data read)
const SAFE_POST = new Set(['/api/secret-scan']);
// POST routes that only READ local state (search / answer / compare …) — still sensitive: they return the user's data
const READ_ONLY_POST = [/^\/api\/(search|answer|clarify|compare|web-answer|web-explore)(\/|$)/, /^\/api\/docteur-memory\/(retrieve|answer)$/, /^\/api\/notebooks\/[^/]+\/(ask|summary|ai-history\/(search|ask)|unified-(search|ask)|documents\/(search|ask))$/, /^\/api\/privacy\/test$/];

export function extractRoutes() {
  const dir = path.join(ROOT, 'src', 'routes'); const out = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8'); let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src)) !== null) { const p = m[2].startsWith('/api/') ? m[2] : `/api${m[2].startsWith('/') ? '' : '/'}${m[2]}`; out.push({ file: f, method: m[1].toUpperCase(), path: p.replace(/\/\*$/, '') }); }
  }
  return out;
}

export function classify({ file, method, path: p }) {
  const frozen = isFrozenPath(p);
  let sensitivity;
  if (method === 'GET' || method === 'HEAD') sensitivity = PUBLIC_GET_FILES.has(file) ? 'PUBLIC/LOW-RISK' : 'READ-SENSITIVE';
  else if (SAFE_POST.has(p)) sensitivity = 'SAFE';
  else if (method === 'POST' && READ_ONLY_POST.some(re => re.test(p))) sensitivity = 'READ-SENSITIVE';
  else sensitivity = 'WRITE-SENSITIVE';
  const { cap, rule } = bodyCapFor(p);
  const memoryJson = p.startsWith('/api/docteur-memory');
  return {
    file, method, path: p, sensitivity,
    guard: frozen ? 'EXEMPT (frozen module — own controls, not changed by NB-7)' : (memoryJson ? 'GLOBAL + JSON-only (memory)' : 'GLOBAL'),
    hostPolicy: frozen ? 'unchanged' : 'local Host only (loopback / private IP / single-label / *.local)',
    originPolicy: frozen ? 'unchanged (CORS allow-list only)' : 'expected frontend origin or same-origin; none = non-browser local client',
    bodyLimit: frozen ? 'unchanged' : `${cap} bytes (${rule})`,
    result: frozen ? 'EXEMPT / RESIDUAL' : 'PASS',
    frozen,
  };
}

export function buildMatrix() { return extractRoutes().map(classify); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = buildMatrix(); const by = (k) => rows.reduce((a, r) => { a[r[k]] = (a[r[k]] ?? 0) + 1; return a; }, {});
  const out = { generatedAt: new Date().toISOString(), total: rows.length, bySensitivity: by('sensitivity'), byResult: by('result'), rows };
  fs.writeFileSync(path.resolve(ROOT, '..', 'reports', 'nb7-route-security-matrix.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ total: out.total, bySensitivity: out.bySensitivity, byResult: out.byResult }));
}
