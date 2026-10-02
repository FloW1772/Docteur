// WEB EGRESS GUARD V1 — static audit of every outbound-network primitive in cortex-server/src.
// Run: node --test test-web-egress-static-audit.mjs
//
// Purpose: no outbound call can appear (or silently change class) without being classified. Every file that contains a
// raw `fetch(` / http(s).request|get (counted per source LINE) / node-fetch / WebSocket / EventSource / net|tls.connect / dns usage must be listed
// below with its trust class and the EXACT number of raw call sites. Adding one makes this test fail until a human
// classifies it (and, for PUBLIC_EGRESS, routes it through web-egress-guard.js).
//
// Classes (see reports/WEB_EGRESS_GUARD_V1_2026-10.md §6):
//   GUARD            the guard itself
//   PUBLIC_EGRESS    destination influenced by a user / document / AI / remote data → MUST use safeFetch (0 raw fetch)
//   FIXED_PROVIDER_MIGRATED   constant external host, already routed through safeFetch({ trustedHosts })
//   FIXED_PROVIDER   constant external API base, never user-influenced; POST/JSON API calls; not rerouted (documented)
//   TRUSTED_LOCAL    intentional connection to a known local service (Ollama, kiwix-serve, ComfyUI, PAIR, Docteur API)
//   DEVICE_PROTOCOL  certified OMEGA / RASSILON / Device Fabric transports (never routed through the generic Web guard)
//   SCOPED_GATEWAY   pre-existing certified gateways with their own pinned-DNS implementation (Sherlock, Cyber Audit)
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');

const PATTERNS = {
  fetch: /(^|[^A-Za-z0-9_.$])fetch\s*\(/,
  nodeFetch: /from ['"]node-fetch['"]/,
  httpRequest: /\b(https?)\.(request|get)\b/,
  websocket: /new\s+WebSocket\b|\bEventSource\b/,
  netConnect: /\b(net|tls)\.(connect|createConnection)\s*\(/,
  httpLib: /from ['"](undici|axios|got)['"]/,
};

export function scanSource() {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const rel = path.relative(SRC, full).replaceAll('\\', '/');
      const counts = {};
      for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        for (const [name, re] of Object.entries(PATTERNS)) if (re.test(line)) counts[name] = (counts[name] ?? 0) + 1;
      }
      if (Object.keys(counts).length) out[rel] = counts;
    }
  };
  walk(SRC);
  return out;
}

// file → { cls, counts (exact), note }
const REGISTRY = {
  'lib/web-egress-guard.js': { cls: 'GUARD', counts: { httpRequest: 2, netConnect: 1 }, note: 'pinned transport (lib.request), plus the browser egress proxy (http.request + net.connect CONNECT tunnel, both pinned)' },

  // ── PUBLIC_EGRESS: migrated to safeFetch (0 raw) ──
  // (capture.js, deep-capture.js, image.js, routes/kiwix.js have no raw primitive left: they are absent from this table on purpose;
  //  MIGRATED below asserts they import the guard.)

  // ── FIXED_PROVIDER: constant https API bases (POST/JSON, Authorization), no user-influenced URL component ──
  'lib/providers/anthropic.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 } },
  'lib/providers/gemini.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 2 } },
  'lib/providers/groq.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 } },
  'lib/providers/openai.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 } },
  'lib/providers/openrouter.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 } },
  'lib/whisper-groq.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 } },
  'lib/connectors/google-drive-connector.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 1 }, note: 'OAuth token endpoint (POST, constant)' },
  'lib/connectors/youtube-connector.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 3 }, note: 'OAuth token endpoint ×2 (POST, constant) + Google API GET with constant base' },
  'lib/connectors/onedrive-connector.js': { cls: 'FIXED_PROVIDER', counts: { fetch: 3 }, note: 'OAuth token ×2 (POST, constant) + Graph API GET with constant base; the issued download URL goes through safeFetch' },

  // ── TRUSTED_LOCAL: explicitly typed local services (user-configured or fixed loopback) ──
  'lib/providers/comfyui.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 2 }, note: 'ComfyUI endpoint configured in settings (local service)' },
  'lib/providers/freellmapi.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 1 }, note: 'FreeLLMAPI base URL configured in settings (local service)' },
  'lib/providers/pair.js': { cls: 'TRUSTED_LOCAL', counts: { nodeFetch: 1, fetch: 5 }, note: 'NVIDIA PAIR endpoint configured in settings (local service)' },
  'routes/ollama.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 3 }, note: 'Ollama (local service)' },
  'routes/local-ai.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 1 }, note: 'Ollama /api/tags (local service)' },
  'lib/kiwix-client.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 2 }, note: 'kiwix-serve on 127.0.0.1:<configured port>' },
  'lib/kiwix.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 1 }, note: 'kiwix-serve readiness probe on 127.0.0.1' },
  'lib/maitre-host-isolation.js': { cls: 'TRUSTED_LOCAL', counts: { fetch: 1 }, note: 'MAÎTRE (FROZEN): Docteur health endpoint on 127.0.0.1 — untouched' },

  // ── DEVICE_PROTOCOL: certified, never routed through the Web guard ──
  'lib/omega-outbound-network.js': { cls: 'DEVICE_PROTOCOL', counts: { httpRequest: 2 }, note: 'OMEGA V2 outbound TLS (pinned certificate) — FROZEN, untouched' },
  'lib/rassilon-controller.js': { cls: 'DEVICE_PROTOCOL', counts: { httpRequest: 1 }, note: 'RASSILON LAN controller (pinned certificate) — FROZEN, untouched' },

  // ── SCOPED_GATEWAY: certified gateways with their own pinned-DNS + per-hop revalidation ──
  'lib/cyber-gateway.js': { cls: 'SCOPED_GATEWAY', counts: { httpRequest: 2, netConnect: 1 }, note: 'Observateur / Cyber Audit gateway (FROZEN): scope-checked, pinned lookup, per-hop revalidation' },
  'lib/sherlock-policy.js': { cls: 'SCOPED_GATEWAY', counts: { httpRequest: 1 }, note: 'Sherlock publicRequest: pinned lookup, per-hop revalidation, 3 redirects' },
};

// Files that MUST route through the guard and keep zero raw primitives.
const MIGRATED = {
  'lib/capture.js': 'PUBLIC_EGRESS',
  'lib/deep-capture.js': 'PUBLIC_EGRESS (+ Playwright route guard)',
  'lib/image.js': 'PUBLIC_EGRESS',
  'routes/kiwix.js': 'PUBLIC_EGRESS (metalink + mirror download)',
  'lib/comfyui-install-manager.js': 'FIXED_PROVIDER_MIGRATED',
  'lib/comfyui-model-manager.js': 'FIXED_PROVIDER_MIGRATED',
  'lib/free-ai-catalog.js': 'FIXED_PROVIDER_MIGRATED',
  'lib/kiwix-catalog.js': 'FIXED_PROVIDER_MIGRATED',
  'lib/web-search.js': 'FIXED_PROVIDER_MIGRATED',
  'server.js': 'FIXED_PROVIDER_MIGRATED (oEmbed)',
  'lib/connectors/google-drive-rate-limit.js': 'FIXED_PROVIDER_MIGRATED',
};

test('every outbound primitive in src/ is classified with its exact call-site count', () => {
  const actual = scanSource();
  const problems = [];
  for (const [file, counts] of Object.entries(actual)) {
    const entry = REGISTRY[file];
    if (!entry) { problems.push(`UNCLASSIFIED outbound primitive in ${file}: ${JSON.stringify(counts)}`); continue; }
    if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(entry.counts).sort())) {
      problems.push(`${file} (${entry.cls}) call-site count changed: registered ${JSON.stringify(entry.counts)}, found ${JSON.stringify(counts)}`);
    }
  }
  for (const file of Object.keys(REGISTRY)) if (!actual[file]) problems.push(`${file} is registered but contains no outbound primitive any more — update the registry`);
  assert.deepEqual(problems, []);
});

test('PUBLIC_EGRESS and migrated callsites import the guard and keep NO raw fetch / http(s).request', () => {
  const actual = scanSource();
  for (const [file, cls] of Object.entries(MIGRATED)) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.match(text, /web-egress-guard\.js/, `${file} (${cls}) must import the guard`);
    assert.match(text, /\bsafeFetch\b/, `${file} (${cls}) must call safeFetch`);
    assert.equal(actual[file], undefined, `${file} (${cls}) still has a raw outbound primitive: ${JSON.stringify(actual[file])}`);
  }
});

test('OneDrive: the Graph-issued download URL goes through the guard (the 3 remaining raw fetches are constant-base API calls)', () => {
  const text = fs.readFileSync(path.join(SRC, 'lib/connectors/onedrive-connector.js'), 'utf8');
  assert.match(text, /web-egress-guard\.js/);
  assert.match(text, /fetchImpl:\s*\(target, init\)\s*=>\s*safeFetch\(/);
});

test('no blind redirect-following anywhere: `redirect: \'follow\'` is gone from src/', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) return;
          if (/redirect\s*:\s*['"]follow['"]/.test(line)) offenders.push(`${path.relative(SRC, full)}:${i + 1}`);
        });
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});

test('the test-only seams of the guard are never used by production code', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name) || entry.name === 'web-egress-guard.js') continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/createEgressClient|addressPolicy|\b_config\b/.test(text)) offenders.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'production code must use the default strict exports of web-egress-guard.js');
});

test('every headless-browser launch in src/ goes through the shared egress proxy', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/chromium\.(launch|connect|launchPersistentContext)\s*\(/.test(text) && !/getSharedBrowserEgressProxy/.test(text)) offenders.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], 'a Chromium launch bypasses the egress proxy');
});

test('frozen / certified device protocols and local-service transports were NOT rerouted through the guard', () => {
  for (const file of ['lib/omega-outbound-network.js', 'lib/rassilon-controller.js', 'lib/cyber-gateway.js', 'lib/maitre-host-isolation.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(SRC, file), 'utf8'), /web-egress-guard/, `${file} must keep its own trust path`);
  }
  for (const file of fs.readdirSync(path.join(SRC, 'lib')).filter(f => /^(device-fabric|omega|rassilon|maitre|monitor|notebook)/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'lib', file), 'utf8'), /web-egress-guard/, `${file} (frozen module) must not import the guard`);
  }
});
