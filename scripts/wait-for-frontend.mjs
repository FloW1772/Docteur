// [STARTUP-1] Frontend readiness gate for Docteur-Launcher.bat: Chrome opens only once the Vite dev server actually
// answers on loopback with the Docteur page (no blind delay). Read-only GET, loopback addresses only (no DNS), bounded.
// Exit codes: 0 ready · 1 not ready before the timeout · 2 another service answers on the port · 3 non-loopback URL.
//   node scripts/wait-for-frontend.mjs [--url http://localhost:5173/] [--timeout-ms 60000] [--interval-ms 500]
//   node scripts/wait-for-frontend.mjs --identify   one probe: 0 = Docteur frontend answers, 2 = another service, 1 = none
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_URL = 'http://localhost:5173/';
export const DOCTEUR_MARKER = '<title>Docteur — Cortex Personnel</title>';
const LOOPBACK = { localhost: ['::1', '127.0.0.1'], '127.0.0.1': ['127.0.0.1'], '[::1]': ['::1'] };
const BODY_LIMIT = 64 * 1024;

/** Loopback addresses to probe for a URL (localhost = ::1 then 127.0.0.1, as Chrome), or null when not loopback HTTP. */
export function loopbackTarget(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const addresses = LOOPBACK[parsed.hostname];
  if (parsed.protocol !== 'http:' || !addresses || parsed.username || parsed.password) return null;
  return { addresses, port: Number(parsed.port || 80), path: `${parsed.pathname}${parsed.search}` };
}

const request = (address, port, path, timeoutMs) => new Promise(resolve => {
  const req = http.get({ host: address, family: address.includes(':') ? 6 : 4, port, path, timeout: timeoutMs, headers: { accept: 'text/html' } }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { if (body.length < BODY_LIMIT) body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
    res.on('error', () => resolve({ error: 'RESPONSE_ERROR' }));
  });
  req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
  req.on('error', error => resolve({ error: error.code ?? 'ERROR' }));
});

/** One probe: 'ready' (Docteur page), 'foreign' (an HTTP answer that is not Docteur) or 'down' (no HTTP answer). */
export async function probeFrontend(target, { requestTimeoutMs = 2000 } = {}) {
  let last = { state: 'down', detail: 'ECONNREFUSED' };
  for (const address of target.addresses) {
    const r = await request(address, target.port, target.path, requestTimeoutMs);
    if (r.error) { if (last.state === 'down') last = { state: 'down', detail: r.error }; continue; }
    if (r.status === 200 && r.body.includes(DOCTEUR_MARKER)) return { state: 'ready', address, status: r.status };
    last = { state: 'foreign', detail: `HTTP ${r.status}`, address };
  }
  return last;
}

/** Polls until ready, a persistent foreign service, or the deadline. Never throws. */
export async function waitForFrontend({ url = DEFAULT_URL, timeoutMs = 60000, intervalMs = 500, foreignGraceMs = 3000, probe = probeFrontend, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const target = loopbackTarget(url);
  if (!target) return { code: 3, outcome: 'not-loopback', elapsedMs: 0, attempts: 0 };
  const started = now();
  let attempts = 0, foreignSince = null, last = null;
  while (true) {
    attempts += 1;
    last = await probe(target);
    const elapsedMs = now() - started;
    if (last.state === 'ready') return { code: 0, outcome: 'ready', elapsedMs, attempts, last };
    // Vite never answers with a foreign page while starting, so a lasting foreign answer means the port is taken
    foreignSince = last.state === 'foreign' ? (foreignSince ?? elapsedMs) : null;
    if (foreignSince !== null && elapsedMs - foreignSince >= foreignGraceMs) return { code: 2, outcome: 'foreign', elapsedMs, attempts, last };
    if (elapsedMs + intervalMs > timeoutMs) return { code: last.state === 'foreign' ? 2 : 1, outcome: last.state === 'foreign' ? 'foreign' : 'timeout', elapsedMs, attempts, last };
    await sleep(intervalMs);
  }
}

const stateText = last => (!last ? 'aucune réponse'
  : last.state === 'foreign' ? `un autre service répond (${last.detail})`
  : last.detail === 'ECONNREFUSED' ? 'connexion refusée' : `pas de réponse HTTP (${last.detail})`);

export function describe(result, url, timeoutMs) {
  if (result.code === 0) return `[startup] Frontend prêt après ${result.elapsedMs} ms (${url}, ${new Date().toISOString()})`;
  if (result.code === 3) return `FRONTEND_PROBE_NOT_LOOPBACK : ${url} n'est pas une adresse locale (localhost, 127.0.0.1 ou [::1]). Aucune requête envoyée.`;
  const head = result.code === 2
    ? `FRONTEND_PORT_BUSY : ${stateText(result.last)} sur ${url}, mais ce n'est pas Docteur.`
    : `FRONTEND_NOT_READY : le frontend Docteur ne répond pas sur ${url} après ${Math.round(timeoutMs / 1000)} s (dernier état : ${stateText(result.last)}).`;
  return `${head}\nChrome n'a pas été ouvert. Consulter la fenêtre "Docteur Frontend" pour l'erreur de Vite.`;
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main(args) {
  const url = argValue(args, '--url', DEFAULT_URL);
  if (args.includes('--identify')) {
    const target = loopbackTarget(url);
    if (!target) { console.error(describe({ code: 3 }, url)); return 3; }
    const r = await probeFrontend(target);
    if (r.state === 'foreign') console.error(`FRONTEND_PORT_BUSY : ${stateText(r)} sur ${url}, mais ce n'est pas Docteur. Rien n'a été arrêté ; fermer ce programme puis relancer Docteur.`);
    else if (r.state === 'down') console.error(`FRONTEND_PORT_UNKNOWN : un processus occupe ${url} sans répondre en HTTP (${r.detail}). Rien n'a été arrêté ; fermer l'ancienne fenêtre "Docteur Frontend" puis relancer.`);
    return r.state === 'ready' ? 0 : r.state === 'foreign' ? 2 : 1;
  }
  const timeoutMs = Number(argValue(args, '--timeout-ms', 60000));
  const intervalMs = Number(argValue(args, '--interval-ms', 500));
  if (!(timeoutMs > 0) || !(intervalMs > 0)) { console.error('FRONTEND_PROBE_BAD_ARGS : --timeout-ms et --interval-ms doivent être positifs.'); return 3; }
  console.log(`Attente du frontend sur ${url} (max ${Math.round(timeoutMs / 1000)} s)...`);
  const result = await waitForFrontend({ url, timeoutMs, intervalMs });
  (result.code === 0 ? console.log : console.error)(describe(result, url, timeoutMs));
  return result.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
