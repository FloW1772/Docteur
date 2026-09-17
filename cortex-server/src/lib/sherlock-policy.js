import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SHERLOCK_SHA = 'a38ba54fda799cd786a2ab67a50143e1a63169e6';
export const SOURCE_ROOT = path.join(REPO_ROOT, 'external/Sherlock-source', SHERLOCK_SHA);
export const RUNTIME_ROOT = path.join(REPO_ROOT, 'external/Sherlock-runtime');
export const WORKSPACES_ROOT = path.join(REPO_ROOT, 'cortex-server/data/sherlock-workspaces');
export const DATABASE_HASH = '3fdfc6694c5cd99798881215554b09e617c6d5284a6219fae309882566a9fb30';
export const LIMITS = Object.freeze({ sites: 30, outputBytes: 128 * 1024, responseBytes: 512 * 1024, redirects: 3, timeoutMs: 120000, requestMs: 8000, intervalMs: 250, rateWindowMs: 60000, rateCount: 3 });
export function denied(code) { return Object.assign(new Error(code), { code }); }
export function validateUsername(value) {
  // Preserve the input exactly; Unicode letters/numbers plus common handles.
  if (typeof value !== 'string' || value.length > 64 || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(value) || value.includes('..')) throw denied('username_invalid');
  return value;
}
export function checkedPath(root, candidate) {
  const absoluteRoot = path.resolve(root), target = path.resolve(root, candidate);
  const rel = path.relative(absoluteRoot, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw denied('path_denied');
  // Include all ancestors: a junction on the workspace root is also denied.
  let current = target;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw denied('symlink_denied');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return target;
}
export function childEnvironment(workspace, source = process.env) {
  const home = checkedPath(workspace, 'home'), temp = checkedPath(workspace, 'tmp');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
  const systemRoot = source.SystemRoot || source.SYSTEMROOT || 'C:\\Windows';
  return {
    SYSTEMROOT: systemRoot, WINDIR: systemRoot,
    PATH: path.join(systemRoot, 'System32'),
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
    TEMP: temp, TMP: temp, APPDATA: home, LOCALAPPDATA: home,
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
  };
}
export function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) === 6) {
    // Permit only ordinary global unicast; reject mapped IPv4, NAT64,
    // transition mechanisms and documentation space, not merely ::1.
    const h = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(h) && !h.startsWith('2001:') && !h.startsWith('2002:') && !h.startsWith('3fff:');
  }
  return false;
}
export function publicUrl(raw) {
  let url; try { url = new URL(raw); } catch { throw denied('url_invalid'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) ||
    host === 'localhost' || !host.includes('.') && !net.isIP(host) || /\.(localhost|local|internal|lan)$/.test(host) ||
    (net.isIP(host) && !publicAddress(host))) throw denied('network_destination_denied');
  return url;
}
export async function resolvePublic(raw, lookup = dns.lookup) {
  const url = publicUrl(raw), host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw denied('network_destination_denied');
  return { url, address: addresses[0] };
}
export async function publicRequest(raw, { method = 'GET', redirects = true, signal, lookup = dns.lookup, transport } = {}) {
  if (!['GET', 'HEAD'].includes(method)) throw denied('http_method_denied');
  let target = raw;
  for (let hop = 0; hop <= LIMITS.redirects; hop++) {
    const { url, address } = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(denied('request_cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(denied('dns_timeout')); }, LIMITS.requestMs);
      if (signal?.aborted) { clearTimeout(timer); aborted(); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      resolvePublic(target, lookup).then(resolve, reject).finally(cleanup);
    });
    if (signal?.aborted) throw denied('request_cancelled');
    const response = await new Promise((resolve, reject) => {
      const request = (transport || (url.protocol === 'https:' ? https.request : http.request))(url, {
        method, signal, agent: false, timeout: LIMITS.requestMs,
        headers: { 'User-Agent': 'Docteur-Sherlock/1.0', Accept: 'text/html,application/json', 'Accept-Encoding': 'identity' },
        lookup: (_host, opts, callback) => opts?.all ? callback(null, [address]) : callback(null, address.address, address.family),
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > LIMITS.responseBytes) { res.destroy(denied('response_too_large')); request.destroy(denied('response_too_large')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('base64') }));
      });
      const deadline = setTimeout(() => request.destroy(denied('request_timeout')), LIMITS.requestMs);
      request.once('close', () => clearTimeout(deadline));
      request.on('timeout', () => request.destroy(denied('request_timeout')));
      request.on('error', reject); request.end();
    });
    if (redirects && [301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (hop === LIMITS.redirects) throw denied('redirect_limit');
      target = new URL(response.location, url).href; continue;
    }
    return { ...response, url: url.href };
  }
  throw denied('redirect_limit');
}
export function loadSites(filter) {
  const bytes = fs.readFileSync(checkedPath(SOURCE_ROOT, 'sherlock_project/resources/data.json'));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== DATABASE_HASH) throw denied('site_database_changed');
  const all = JSON.parse(bytes);
  const defaults = ['GitHub', 'Reddit', 'GitLab'];
  const names = filter === undefined ? defaults.filter(name => all[name]) : filter;
  if (!Array.isArray(names) || !names.length || names.length > LIMITS.sites || names.some(n => typeof n !== 'string' || !Object.hasOwn(all, n)) || new Set(names).size !== names.length) throw denied('site_filter_invalid');
  return Object.fromEntries(names.map(name => {
    return [name, validateSite(all[name])];
  }));
}
export function validateSite(site) {
  if (!site.url || !['GET', 'HEAD'].includes(site.request_method || 'GET') || site.request_payload) throw denied('site_method_denied');
  publicUrl(site.url.replaceAll('{}', 'audit'));
  if (site.urlProbe) publicUrl(site.urlProbe.replaceAll('{}', 'audit'));
  return { ...site, headers: {} };
}
export function verifySource() {
  const manifest = JSON.parse(fs.readFileSync(new URL('./sherlock-pin.json', import.meta.url), 'utf8'));
  if (manifest.sha !== SHERLOCK_SHA) throw denied('source_pin_invalid');
  for (const file of manifest.files.filter(f => f.path.startsWith('sherlock_project/') || f.path === 'pyproject.toml')) {
    if (crypto.createHash('sha256').update(fs.readFileSync(checkedPath(SOURCE_ROOT, file.path))).digest('hex') !== file.sha256) throw denied('source_changed');
  }
}
