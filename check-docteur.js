// check-docteur.js — verification statique et sante du projet Docteur
// Lance via check-docteur.bat ou : node check-docteur.js

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, extname, relative } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT       = resolve(__dirname);
const SERVER_DIR = join(ROOT, 'cortex-server');

let okCount   = 0;
let warnCount = 0;
let failCount = 0;

function ok(msg)    { console.log(`  [OK]     ${msg}`); okCount++;   }
function warn(msg)  { console.log(`  [WARN]   ${msg}`); warnCount++; }
function fail(msg)  { console.log(`  [ECHEC]  ${msg}`); failCount++; }
function skip(msg)  { console.log(`  [IGNORE] ${msg}`); }
function info(msg)  { console.log(`           ${msg}`); }
function section(t) { console.log(`\n=== ${t} ===`); }

// ── utilitaires ──────────────────────────────────────────────────────────────

function run(cmd, args, cwd, timeoutMs) {
  const r = spawnSync(cmd, args, {
    cwd:     cwd || ROOT,
    encoding: 'utf8',
    timeout:  timeoutMs || 120_000,
    shell:    process.platform === 'win32',
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function httpGet(url, timeoutMs) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout')), timeoutMs || 3000);
    http.get(url, (response) => {
      clearTimeout(timer);
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => res({ status: response.statusCode, body: data }));
    }).on('error', err => { clearTimeout(timer); rej(err); });
  });
}

function fileContent(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

function gatherFiles(dir, exts) {
  const result   = [];
  const excluded = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage', 'data']);
  const allowed  = new Set(exts || ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (excluded.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory())                                  walk(full);
      else if (allowed.has(extname(e.name).toLowerCase())) result.push(full);
    }
  }
  walk(dir);
  return result;
}

// ── check sections ────────────────────────────────────────────────────────────

// Vulnerabilites connues, analysees et jugees non exploitables dans ce projet.
// Format : { pkg, reason, addedDate }
// Toute nouvelle HIGH/CRITICAL hors de cette liste reste un [ECHEC].
const KNOWN_VULN_EXCEPTIONS = [
  {
    pkg:       'fast-uri',
    reason:    'dependance de dev uniquement, ne tourne pas en prod (ajt 2026-08)',
    addedDate: '2026-08',
  },
  {
    pkg:       '@hono/node-server',
    reason:    'faille dans serve-static, fonctionnalite non utilisee dans ce projet (ajt 2026-08)',
    addedDate: '2026-08',
  },
  {
    pkg:       'brace-expansion',
    reason:    'DoS via globbing — transitive dep des outils de build/watch uniquement, jamais expose en prod (ajt 2026-08)',
    addedDate: '2026-08',
  },
  {
    pkg:       'nanoid',
    reason:    'faille sur generateurs non-securises — utilise uniquement par Vite au build, pas en prod (ajt 2026-08)',
    addedDate: '2026-08',
  },
  {
    pkg:       'postcss',
    reason:    'path traversal via sourceMappingURL — ne s\'applique qu\'a la compilation CSS, pas en prod (ajt 2026-08)',
    addedDate: '2026-08',
  },
  {
    pkg:       'undici',
    reason:    'CRLF/cookie injection — serveur appelle uniquement Ollama (localhost) et APIs cloud avec URLs fixes, jamais de donnees utilisateur dans les headers (ajt 2026-08)',
    addedDate: '2026-08',
  },
];

function checkAudit(result, label) {
  try {
    const d = JSON.parse(result.stdout);
    const vulns = d.vulnerabilities ?? {};
    const v = d.metadata?.vulnerabilities ?? {};
    const totalHigh = (v.high || 0) + (v.critical || 0);
    const totalAll  = Object.values(v).reduce((s, n) => s + (Number(n) || 0), 0);

    if (totalHigh === 0) {
      const extra = totalAll > 0 ? ` (${totalAll} basse/moderee)` : '';
      ok(`npm audit ${label} : 0 HIGH/CRITICAL${extra}`);
      return;
    }

    // Trier les vuln HIGH/CRITICAL entre connues et nouvelles
    const knownPkgs = new Set(KNOWN_VULN_EXCEPTIONS.map(e => e.pkg));
    const newVulns  = [];
    const knownHit  = new Set();

    for (const [name, info] of Object.entries(vulns)) {
      const sev = info.severity ?? '';
      if (sev !== 'high' && sev !== 'critical') continue;
      const exception = KNOWN_VULN_EXCEPTIONS.find(e => name.includes(e.pkg));
      if (exception) {
        knownHit.add(exception.pkg);
      } else {
        newVulns.push(`${name} (${sev})`);
      }
    }

    if (knownHit.size > 0) {
      for (const pkg of knownHit) {
        const ex = KNOWN_VULN_EXCEPTIONS.find(e => e.pkg === pkg);
        warn(`npm audit ${label} - vuln connue ignoree : ${pkg} — ${ex.reason}`);
      }
    }

    if (newVulns.length > 0) {
      fail(`npm audit ${label} : ${newVulns.length} HIGH/CRITICAL non referencee(s) -> ${newVulns.join(', ')}`);
    } else {
      ok(`npm audit ${label} : ${knownHit.size} vuln(s) connue(s) ignoree(s), 0 nouvelle`);
    }
  } catch {
    const combined = result.stdout + result.stderr;
    if (combined.includes('found 0 vulnerabilities') || combined.includes('"total":0')) {
      ok(`npm audit ${label} : aucune vulnerabilite`);
    } else if (/critical|high/i.test(combined)) {
      warn(`npm audit ${label} : impossible de parser le rapport (verifier manuellement)`);
    } else {
      warn(`npm audit ${label} : impossible de verifier`);
    }
  }
}

function checkIntegrite() {
  section('1. INTEGRITE DU CODE');

  process.stdout.write('  TypeScript...\r');
  const tsc = run('npx', ['tsc', '--noEmit'], ROOT);
  if (tsc.code === 0) {
    ok('TypeScript : 0 erreur');
  } else {
    fail('TypeScript : erreurs detectees');
    tsc.stdout.split('\n').filter(l => l.trim()).slice(0, 8).forEach(l => info(`  ${l}`));
  }

  process.stdout.write('  Build frontend...\r');
  const build = run('npm', ['run', 'build'], ROOT);
  if (build.code === 0) {
    ok('Build frontend : succes');
  } else {
    fail('Build frontend : echec');
    build.stderr.split('\n').filter(l => l.trim()).slice(0, 6).forEach(l => info(`  ${l}`));
  }

  process.stdout.write('  npm audit frontend...\r');
  checkAudit(run('npm', ['audit', '--json'], ROOT, 30_000), 'Frontend');

  process.stdout.write('  npm audit cortex-server...\r');
  checkAudit(run('npm', ['audit', '--json'], SERVER_DIR, 30_000), 'cortex-server');
}

function checkAssertSafeUrl() {
  // [rel, label, mode]
  // mode: 'direct'   → doit contenir assertSafeUrl()
  //       'delegate'  → delègue à une lib déjà protégée
  //       'no-url'    → ne reçoit aucune URL utilisateur (vérifié manuellement)
  const entries = [
    ['cortex-server/src/lib/capture.js',      'lib/capture.js',      'direct'  ],
    ['cortex-server/src/routes/capture.js',   'routes/capture.js',   'delegate'],
    ['cortex-server/src/lib/deep-capture.js', 'lib/deep-capture.js', 'direct'  ],
    ['cortex-server/src/lib/whisper.js',      'lib/whisper.js',      'direct'  ],
    ['cortex-server/src/routes/download.js',  'routes/download.js',  'direct'  ],
    ['cortex-server/src/lib/image.js',        'lib/image.js',        'direct'  ],
    // routes/pdf.js reçoit uniquement id (interne) et subject (texte libre) — pas d'URL utilisateur
    ['cortex-server/src/routes/pdf.js',       'routes/pdf.js',       'no-url'  ],
  ];

  for (const [rel, label, mode] of entries) {
    const content = fileContent(rel);
    if (content === null) {
      warn(`assertSafeUrl - ${label} introuvable`);
    } else if (mode === 'no-url') {
      ok(`assertSafeUrl - ${label} : sans point d'entree URL (id/subject uniquement)`);
    } else if (content.includes('assertSafeUrl(')) {
      ok(`assertSafeUrl - ${label} : protection directe`);
    } else if (mode === 'delegate') {
      ok(`assertSafeUrl - ${label} : delegue a lib protegee`);
    } else {
      const readsUrlFromBody = /body\??\.url\b|req\.body\.url/.test(content);
      if (readsUrlFromBody) {
        fail(`assertSafeUrl - ${label} : lit body.url sans assertSafeUrl`);
      } else {
        warn(`assertSafeUrl - ${label} : pas d'assertSafeUrl detecte (verifier si URL entrante possible)`);
      }
    }
  }
}

const SECRET_PATTERNS = [
  { re: /AIza[0-9A-Za-z_-]{35}/,    label: 'cle Google (AIza...)'       },
  { re: /gsk_[0-9A-Za-z]{50,}/,     label: 'cle Groq (gsk_...)'         },
  { re: /sk-or-[0-9A-Za-z_-]{40,}/, label: 'cle OpenRouter (sk-or-...)' },
  { re: /sk-ant-[0-9A-Za-z_-]{40,}/,label: 'cle Anthropic (sk-ant-...)'  },
  { re: /sk-[A-Za-z0-9]{48}/,       label: 'cle OpenAI (sk-...)'        },
];

function scanFilesForSecret(files, { re, label }, prefix) {
  for (const f of files) {
    try {
      if (re.test(readFileSync(f, 'utf8'))) {
        fail(`${prefix} - ${label} : ${relative(ROOT, f)}`);
        return true;
      }
    } catch {}
  }
  return false;
}

function checkSecretsInSources() {
  const files = gatherFiles(ROOT);
  let found = false;
  for (const pattern of SECRET_PATTERNS) {
    if (scanFilesForSecret(files, pattern, 'Secret hardcode')) found = true;
  }
  if (!found) ok('Secrets sources : aucun secret hardcode detecte');
}

function checkSecretsInDist() {
  const distDir = join(ROOT, 'dist');
  if (!existsSync(distDir)) { warn('Secrets dist/ : dossier dist/ absent'); return; }
  const files = gatherFiles(distDir, ['.js', '.html', '.css', '.mjs']);
  for (const pattern of SECRET_PATTERNS) {
    if (scanFilesForSecret(files, pattern, 'Secret dans dist/')) return;
  }
  ok('Secrets dist/ : aucun secret dans le build');
}

function checkSecrets() {
  checkSecretsInSources();
  checkSecretsInDist();
}

function checkCors() {
  const content = fileContent('cortex-server/src/server.js');
  if (content === null) {
    warn('CORS : cortex-server/src/server.js introuvable');
  } else if (/origin\s*:\s*['"`]\*['"`]|allowOrigin\s*:\s*['"`]\*['"`]/.test(content)) {
    fail('CORS : wildcard * detecte dans server.js');
  } else {
    ok('CORS : pas de wildcard * dans server.js');
  }
}

function checkGitignore() {
  const content  = fileContent('.gitignore');
  const required = ['certs/', 'cortex-server/data/', '.env', 'dist/', 'node_modules/', '*.log'];
  if (content === null) {
    fail('.gitignore : fichier introuvable');
    return;
  }
  const missing = required.filter(p => !content.includes(p));
  if (missing.length === 0) {
    ok('.gitignore : tous les patterns requis presents');
  } else {
    fail(`.gitignore : patterns manquants -> ${missing.join(', ')}`);
  }
}

function checkSecurite() {
  section('2. SECURITE (verifications statiques)');
  checkAssertSafeUrl();
  checkSecrets();
  checkCors();
  checkGitignore();
}

async function checkServeur() {
  section('3. SANTE DU SERVEUR');

  let serverUp = false;
  try {
    const health = await httpGet('http://localhost:3001/api/health', 2000);
    serverUp = true;
    if (health.status === 200) {
      ok('Serveur : GET /api/health -> 200');
    } else {
      warn(`Serveur : GET /api/health -> ${health.status}`);
    }
  } catch {
    skip('Serveur : cortex-server non demarre - checks serveur ignores');
  }

  if (!serverUp) {
    skip('Neurones : serveur non demarre');
    skip('Ollama   : serveur non demarre');
    return;
  }

  await checkNeurones();
  await checkOllama();
}

async function checkNeurones() {
  try {
    const res = await httpGet('http://localhost:3001/api/neurons', 5000);
    if (res.status !== 200) {
      fail(`Neurones : GET /api/neurons -> ${res.status}`);
      return;
    }
    const d   = JSON.parse(res.body);
    const arr = Array.isArray(d) ? d : (d.pages || []);
    if (arr.length === 0) {
      warn('Neurones : aucun neurone retourne');
    } else {
      const withBlocks = arr.filter(p => Array.isArray(p.blocks) && p.blocks.length > 0);
      if (withBlocks.length > 0) {
        ok(`Neurones : ${arr.length} neurones, ${withBlocks.length} avec blocs non vides`);
      } else {
        warn(`Neurones : ${arr.length} neurones mais blocs absents ou vides`);
      }
    }
  } catch (e) {
    fail(`Neurones : erreur -> ${e.message}`);
  }
}

async function checkOllama() {
  try {
    const res = await httpGet('http://localhost:11434/api/tags', 2000);
    if (res.status === 200) {
      const d = JSON.parse(res.body);
      ok(`Ollama : repond, ${(d.models || []).length} modele(s) disponible(s)`);
    } else {
      warn(`Ollama : repond ${res.status}`);
    }
  } catch {
    warn('Ollama : non accessible sur localhost:11434');
  }
}

// ── entree principale ────────────────────────────────────────────────────────

console.log('');
console.log('============================================');
console.log('  CHECK DOCTEUR  -  Verification du projet');
console.log('============================================');

checkIntegrite();
checkSecurite();
let serverWasUp = false;
{
  // Detect server availability before running server checks
  let _up = false;
  try {
    const h = await httpGet('http://localhost:3001/api/health', 2000);
    _up = h.status === 200;
  } catch {}
  serverWasUp = _up;
}
await checkServeur();

console.log('');
console.log('============================================');
let statusLine = 'TOUT OK';
if (failCount > 0)  statusLine = 'ECHECS DETECTES';
else if (warnCount > 0) statusLine = 'AVERTISSEMENTS';
console.log(`  ${statusLine}`);
console.log(`  ${okCount} OK  |  ${warnCount} avertissement(s)  |  ${failCount} echec(s) critique(s)`);
if (!serverWasUp) {
  console.log('');
  console.log('  ⚠  Checks serveur ignores — relancer avec Docteur demarre');
  console.log('     pour un bilan complet (sante serveur, neurones, Ollama).');
}
console.log('============================================');
console.log('');

if (failCount > 0) process.exit(1);
