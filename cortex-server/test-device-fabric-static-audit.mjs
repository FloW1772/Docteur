// DEVICE FABRIC — static security audit of the Fabric source (Phase 2 + 3).
// Comments are stripped before scanning so documentation may name the
// forbidden things it explains.
// Run with: node --test test-device-fabric-static-audit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const FILES = {
  service: path.join(here, 'src/lib/device-fabric.js'),
  agents: path.join(here, 'src/lib/device-fabric-agents.js'),
  routing: path.join(here, 'src/lib/device-fabric-routing.js'),
  route: path.join(here, 'src/routes/device-fabric.js'),
};
const BACKEND = Object.values(FILES);
const INVENTORY = [FILES.service, FILES.agents];
const FRONTEND = [path.join(repo, 'src/components/settings/DeviceFabricSettingsTab.tsx')];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const read = file => stripComments(fs.readFileSync(file, 'utf8'));
// The routing module names execution/authority words only inside its
// FORBIDDEN_FIELD rejection regex, and passes the worker PUBLIC key only to
// RASSILON's own verifyRemoteResult(); both are removed before pattern scans.
const BOUND_VERIFY = 'verifyRemoteResult(result, { expectedWorkerId: worker.deviceId, expectedJobId: jobId, publicKeyPem: worker.publicKeyPem })';
const readRoutingScanned = () => read(FILES.routing)
  .replace(/const FORBIDDEN_FIELD = \/[^\n]*\/i;/, '')
  .replace(BOUND_VERIFY, 'verifyRemoteResult(<bound>)');
const scan = file => (file === FILES.routing ? readRoutingScanned() : read(file));

function importSpecifiers(file) {
  const source = read(file);
  return [...new Set([...source.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm), ...source.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map(m => m[1]))].sort();
}

function namedImports(file, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = read(file).match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`));
  return match ? match[1].split(',').map(s => s.trim()).filter(Boolean).sort() : [];
}

function fabricSqlBlocks() {
  const source = fs.readFileSync(path.join(here, 'src/lib/sqlite.js'), 'utf8');
  const slice = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start > 0 && end > start, `block delimited: ${startMarker}`);
    return stripComments(source.slice(start, end)).replace(/--.*$/gm, '');
  };
  return {
    migration: slice('// DEVICE FABRIC audit columns', 'export function initSqlite('),
    schema: slice('// ── DEVICE FABRIC Phase 2 — inventory', '  migrateFabricAuditTable();'),
    store: slice('// ── DEVICE FABRIC Phase 2 store', '// ── END DEVICE FABRIC Phase 2 store'),
  };
}

test('Fabric source files exist', () => {
  for (const file of [...BACKEND, ...FRONTEND]) assert.ok(fs.existsSync(file), file);
});

test('never calls or imports ensureLocalRassilonDevice (it can create a RASSILON identity)', () => {
  for (const file of [...BACKEND, ...FRONTEND]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /ensureLocalRassilonDevice/, file);
  }
});

test('no execution, shell, dynamic code, process or model-download primitives', () => {
  const forbidden = [
    /shell\s*:\s*true/, /\bexec(File|Sync)?\s*\(/, /\bspawn(Sync)?\s*\(/, /\beval\s*\(/, /new\s+Function\b/, /cmd\.exe/i,
    /powershell\b(?!\|)/i, /child_process/, /Invoke-Expression/i, /\brun\s*\(\s*command/, /ollama\s+pull|\.pull\s*\(/i,
    /WebAssembly|vm\.run|require\s*\(/,
  ];
  for (const file of BACKEND) {
    // The routing module names these words only inside its forbidden-field regex.
    const source = scan(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.basename(file)}: ${pattern}`);
  }
});

test('no network of its own: no HTTP/WebSocket client, socket, listener, discovery, proxy or download', () => {
  const forbidden = [
    /\bfetch\s*\(/, /\baxios\b/, /node:(https?|net|tls|dgram|dns)\b/, /from\s+'(https?|net|tls|dgram|dns)'/, /\bWebSocket\b/,
    /\.listen\s*\(/, /createServer\s*\(/, /\bmdns\b|bonjour|multicast|broadcast/i, /\bdownload\b/i, /@hono\/node-server'/,
    /requestJsonPinnedTls|requestPairingJsonPinnedTls|https\.request/, /\/rassilon-lan\//,
  ];
  for (const file of BACKEND) {
    const source = read(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.basename(file)}: ${pattern}`);
  }
});

test('imports are limited to the documented allowlist per module', () => {
  assert.deepEqual(importSpecifiers(FILES.service), ['./device-fabric-agents.js', './sqlite.js', 'node:crypto']);
  assert.deepEqual(importSpecifiers(FILES.agents), ['./rassilon-scheduler.js', './rassilon-worker.js', './sqlite.js']);
  assert.deepEqual(importSpecifiers(FILES.routing), ['./device-fabric.js', './rassilon-controller.js', './rassilon-remote-result.js', './sqlite.js', 'node:crypto']);
  assert.deepEqual(importSpecifiers(FILES.route), ['../lib/device-fabric-routing.js', '../lib/device-fabric.js', '@hono/node-server/conninfo', 'hono', 'hono/body-limit']);
});

test('agent-owned functions imported by Fabric are exactly the whitelisted ones', () => {
  assert.deepEqual(namedImports(FILES.agents, './sqlite.js'), [
    'getAllOmegaDevices', 'getOmegaDeviceById', 'getRassilonDevice', 'getRassilonDeviceSessionView',
    'getRassilonLocalDevice', 'getRassilonSettings', 'listRassilonDevices', 'listRassilonIdentities',
  ]);
  assert.deepEqual(namedImports(FILES.agents, './rassilon-scheduler.js'), ['ONLINE_AFTER_MS', 'STALE_AFTER_MS', 'deriveDevicePresence']);
  assert.deepEqual(namedImports(FILES.agents, './rassilon-worker.js'), ['getRassilonStatus']);
  // Phase 3 routing: RASSILON's own certified controller entry points only.
  assert.deepEqual(namedImports(FILES.routing, './rassilon-controller.js'), ['dispatchRassilonRemoteJob', 'pollRassilonRemoteResult', 'refreshRassilonWorkerStatus']);
  assert.deepEqual(namedImports(FILES.routing, './rassilon-remote-result.js'), ['verifyRemoteResult']);
  const routingSqlite = namedImports(FILES.routing, './sqlite.js');
  for (const name of routingSqlite) {
    assert.match(name, /^(getRassilonDevice|getRassilonLocalDevice|getRassilonOutboundSession|getFabricDevice|\w*FabricOperation\w*|insertFabricAudit)$/, name);
  }
});

test('no key, secret-store, DPAPI, signing, pairing access anywhere in Fabric', () => {
  const forbidden = [
    /secret-store/, /secretStore/, /dpapi/i, /-identity\.js/, /signWithDeviceKey/, /generateDeviceIdentity/, /deleteDeviceKey/,
    /getDeviceKeyStatus/, /createPrivateKey|privateKey|PRIVATE KEY/, /omega-pairing|rassilon-pairing|startPairing|approvePairing|confirmRassilonPairing/,
    /publicKeyPem\s*:/, /tlsCertificatePem\s*:/, /omega_sessions|rassilon_sessions|rassilon_outbound_sessions|rassilon_request_nonces/,
    /createSession|validateAndAdvanceSession|endSession|getRassilonSession|createRassilonSession|upsertRassilonOutboundSession/,
  ];
  for (const file of [...BACKEND, ...FRONTEND]) {
    const source = scan(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.basename(file)}: ${pattern}`);
  }
});

test('inventory modules keep the Phase 2 rule: no session, token or controller access', () => {
  for (const file of INVENTORY) {
    const source = read(file);
    for (const pattern of [
      /\bsessionId\b|\bnonce\b|\btoken\b/i, /getRassilonOutboundSession/,
      /dispatchRassilonRemoteJob|pollRassilonRemoteResult|refreshRassilonWorkerStatus|rassilon-controller/,
    ]) assert.doesNotMatch(source, pattern, `${path.basename(file)}: ${pattern}`);
  }
});

test('routing module: session id is only handed to RASSILON functions, never stored or returned', () => {
  const source = readRoutingScanned();
  const uses = [...source.matchAll(/session\.sessionId/g)].length;
  const passedToRassilon = [...source.matchAll(/(?:pollRassilonRemoteResult|refreshRassilonWorkerStatus)\(\{[^}]*sessionId: session\.sessionId/g)].length;
  assert.equal(uses, passedToRassilon, 'every session.sessionId use is an argument of a RASSILON call');
  assert.ok(uses >= 2);
  assert.doesNotMatch(source, /(insertFabricOperation|updateFabricOperation|insertFabricAudit|finish)\([^)]*sessionId/);
  assert.doesNotMatch(source, /\btoken\b|\bnonce\b/i);
});

test('exact-target dispatch: devices is always the single linked worker, and no retargeting helper exists', () => {
  const source = read(FILES.routing);
  const calls = [...source.matchAll(/dispatchRassilonRemoteJob\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.equal(calls.length, 1, 'exactly one dispatch call site');
  assert.match(calls[0], /devices:\s*\[worker\]/);
  assert.match(calls[0], /preferredDeviceId:\s*worker\.deviceId/);
  assert.doesNotMatch(source, /listRassilonDevices|selectRassilonWorker|getRassilonDevicesForFabric|fallback\s*\(|retry\s*\(/);
  assert.equal([...source.matchAll(/dispatchRassilonRemoteJob\(/g)].length, 1, 'no second dispatch (no automatic retry)');
});

test('no OMEGA action, stop-all, cancel, enable, revoke or settings mutation', () => {
  const forbidden = [
    /killAllRassilonWork|cancelJobById|cancelJobsByIssuer/, /submitJob|enqueue/i,
    /enableRassilon|disableRassilon|pauseRassilon|resumeRassilon|changeRassilonSettings|setRassilonEnabled|startRassilonLanServer|stopRassilonLanServer/,
    /revokeDevice|revokeOmegaDevice|revokeRassilonDevice/, /upsertRassilon|insertOmega|updateRassilonDevicePresence|touchOmega|touchRassilon/,
    /omega-view|omega-interactive|omega-admin|omega-input|omega-capture|omega-windows-exec|omega-session|omega-devices|maitre-/,
    /['"`]\/(execute|run|action|command|dispatch|shell|tool|rpc)\b/,
  ];
  for (const file of [...BACKEND, ...FRONTEND]) {
    const source = read(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${path.basename(file)}: ${pattern}`);
  }
});

test('Fabric SQL (schema, migration, store) only references fabric_* tables and has no FK into agent tables', () => {
  const { schema, migration, store } = fabricSqlBlocks();
  for (const block of [schema, migration, store]) {
    assert.doesNotMatch(block, /\b(omega|rassilon|maitre|monitor|cyber)_[a-z_]+/);
    const tables = [...block.matchAll(/\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?|REFERENCES|ON|RENAME TO)\s+([a-z_0-9]+)/g)].map(m => m[1]);
    assert.ok(tables.length > 0);
    // sqlite_master is only read to detect the Phase 2 audit schema.
    for (const table of tables) assert.match(table, /^(fabric_|sqlite_master$)/, table);
  }
  assert.doesNotMatch(schema, /private|secret|token|session|nonce|password|pairing|certificate|ip_address|hostname|username|vectors|texts/i);
});

test('frontend renders Fabric data as text only and offers no generic control', () => {
  for (const file of FRONTEND) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(source, />\s*(FULL CONTROL|CONTROL DEVICE|RUN ANYTHING|RUN|EXECUTE|COMMAND)\s*</i);
    assert.doesNotMatch(source, /actionType:\s*'OMEGA_/);
  }
});

test('no voice intent, agent tool, command registry or LLM agent reaches Device Fabric', () => {
  const frontendLib = fs.readdirSync(path.join(repo, 'src/lib')).filter(name => /voice|intent|registry|command|agent/i.test(name));
  assert.ok(frontendLib.length > 0);
  for (const name of frontendLib) {
    const full = path.join(repo, 'src/lib', name);
    if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /device-fabric|deviceFabric/i, name);
  }
  const backend = fs.readdirSync(path.join(here, 'src/lib')).filter(name => /agent-runner|tool|metagpt|business|external-agent|voice/i.test(name));
  assert.ok(backend.length > 0);
  for (const name of backend) {
    assert.doesNotMatch(fs.readFileSync(path.join(here, 'src/lib', name), 'utf8'), /device-fabric/i, name);
  }
  // The only frontend caller of the routing API is the Devices settings tab.
  const callers = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /deviceFabricRoute\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(path.relative(repo, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(repo, 'src'));
  assert.deepEqual(callers.sort(), ['src/components/settings/DeviceFabricSettingsTab.tsx', 'src/lib/cortex/client.ts']);
});

// ── Phase 4: single attempt, human trigger only ────────────────────────────

test('route and probe are single-attempt in the client: never the retrying apiFetch', () => {
  const client = fs.readFileSync(path.join(repo, 'src/lib/cortex/client.ts'), 'utf8');
  const body = name => {
    const start = client.indexOf(`  ${name}(`);
    assert.ok(start > 0, name);
    return client.slice(start, client.indexOf('\n  },', start));
  };
  for (const method of ['deviceFabricRoute', 'deviceFabricProbe']) {
    assert.match(body(method), /deviceFabricPostOnce\(/, method);
    assert.doesNotMatch(body(method), /apiFetch|deviceFabricJson/, method);
  }
  const helperStart = client.indexOf('async function deviceFabricPostOnce');
  const helper = client.slice(helperStart, client.indexOf('\n}\n', helperStart));
  assert.match(helper, /fetchTimeout\(/);
  assert.doesNotMatch(helper, /apiFetch|for \(|while \(|retry/i);
});

test('backend: only the Fabric route and server boot import the routing module', () => {
  const importers = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /from\s+'[^']*device-fabric-routing\.js'|import\(\s*'[^']*device-fabric-routing\.js'/.test(read(full))) importers.push(path.relative(here, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(here, 'src'));
  assert.deepEqual(importers.sort(), ['src/routes/device-fabric.js', 'src/server.js']);
  const server = read(path.join(here, 'src/server.js'));
  assert.doesNotMatch(server, /routeFabricAction|probeRassilonWorker/, 'the server only runs boot recovery, never a route or probe');
});

test('frontend: timers never probe or route; probe and route only from explicit click handlers', () => {
  const tab = fs.readFileSync(FRONTEND[0], 'utf8');
  for (const call of ['deviceFabricProbe(', 'deviceFabricRoute(']) {
    assert.equal(tab.split(call).length - 1, 1, `${call} has one call site`);
  }
  for (const match of tab.matchAll(/setInterval\(([\s\S]*?)\)[,;]/g)) {
    assert.doesNotMatch(match[1], /deviceFabricProbe|deviceFabricRoute|routeTo/, 'no interval-driven probe or route');
  }
  const probeIndex = tab.indexOf('deviceFabricProbe(');
  assert.match(tab.slice(Math.max(0, probeIndex - 200), probeIndex), /onClick=/, 'probe only from a click');
  assert.doesNotMatch(tab, /\bCANCEL\b|deviceFabricCancel|\/cancel/i, 'no cancel button without a certified primitive');
  assert.doesNotMatch(tab, /FULL CONTROL|CONTROL PC|RUN ANYTHING|EXECUTE COMMAND|\bTERMINAL\b/i);
});

test('no CommandBar, voice, MetaGPT, business agent or scheduler path reaches Device Fabric', () => {
  const frontendHits = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /device-fabric|deviceFabric|DeviceFabric/.test(fs.readFileSync(full, 'utf8'))) frontendHits.push(path.relative(repo, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(repo, 'src'));
  assert.deepEqual(frontendHits.sort(), ['src/components/modals/SettingsModal.tsx', 'src/components/settings/DeviceFabricSettingsTab.tsx', 'src/lib/cortex/client.ts']);
  const backendHits = [];
  const walkBackend = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkBackend(full);
      else if (entry.name.endsWith('.js') && /device-fabric/.test(fs.readFileSync(full, 'utf8'))) backendHits.push(path.relative(here, full).replace(/\\/g, '/'));
    }
  };
  walkBackend(path.join(here, 'src'));
  assert.deepEqual(backendHits.sort(), ['src/lib/device-fabric-agents.js', 'src/lib/device-fabric-routing.js', 'src/lib/device-fabric.js', 'src/lib/sqlite.js', 'src/routes/device-fabric.js', 'src/server.js']);
});
