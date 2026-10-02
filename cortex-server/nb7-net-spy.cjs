// NB-7 test preload (node --require): records AND BLOCKS every non-loopback network attempt made by the server process
// (TCP connect, DNS lookup, fetch), appending one line per attempt to $NB7_SPY_FILE. Proves "external memory transmission = 0"
// and lets the chat + memory flows run "offline". Loopback (127.0.0.0/8, ::1, localhost) is allowed (Ollama, the API itself).
const fs = require('node:fs'); const net = require('node:net'); const dns = require('node:dns');
const FILE = process.env.NB7_SPY_FILE;
const isLoop = (h) => { const s = String(h ?? '').toLowerCase().replace(/^\[|\]$/g, ''); return !s || s === 'localhost' || s === '::1' || s === '::' || s === '0.0.0.0' || /^127\./.test(s); };
const note = (kind, target) => { try { if (FILE) fs.appendFileSync(FILE, `${Date.now()} ${kind} ${target}\n`); } catch { /* best effort */ } };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0]; const host = typeof a === 'object' && a !== null ? (a.host ?? a.path ?? 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (typeof a === 'object' && a !== null && a.path && !a.host && !a.port) return origConnect.apply(this, args); // unix pipe / windows named pipe
  if (!isLoop(host)) { note('connect', host); const err = new Error(`NB7_OFFLINE: blocked connect ${host}`); err.code = 'ENETUNREACH'; process.nextTick(() => this.destroy(err)); return this; }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) { if (!isLoop(hostname)) { note('dns', hostname); const cb = rest.find(x => typeof x === 'function'); const err = new Error(`NB7_OFFLINE: blocked dns ${hostname}`); err.code = 'ENOTFOUND'; if (cb) return process.nextTick(() => cb(err)); return; } return origLookup.call(this, hostname, ...rest); };
const origFetch = globalThis.fetch;
if (origFetch) globalThis.fetch = function (input, init) { let u = ''; try { u = new URL(typeof input === 'string' ? input : (input.url ?? String(input))).hostname; } catch { /* relative */ } if (u && !isLoop(u)) { note('fetch', u); return Promise.reject(new TypeError(`NB7_OFFLINE: blocked fetch ${u}`)); } return origFetch.call(this, input, init); };
