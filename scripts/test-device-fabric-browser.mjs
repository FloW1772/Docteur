// DEVICE FABRIC Phase 2 — browser test of the real Devices tab against a
// stateful mocked /api/device-fabric. Run with: node scripts/test-device-fabric-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

let browser;
let server;
let assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const now = new Date().toISOString();
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/device-fabric-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => {
  console.error('DEVICE FABRIC browser deadline');
  void browser?.close();
  void server?.close();
  process.exitCode = 1;
}, 90_000);

const XSS_IMG = '<img src=x onerror="window.__xssFired=true">';
const FP = { omega: 'a1'.repeat(32), omegaLinked: 'b2'.repeat(32), omegaRevoked: 'c3'.repeat(32), worker: 'd4'.repeat(32), shared: 'e5'.repeat(32) };
const cap = (name, supported, authorized, available) => ({ name, supported, authorized, available, routable: false });

const agents = {
  OMEGA: [
    { agentType: 'OMEGA', agentDeviceId: 'omega-laptop', displayName: XSS_IMG, fingerprint: FP.omega, role: 'OMEGA_CLIENT', trust: 'TRUSTED', revokedAt: null, lastSessionAt: now, permissionLevel: 2, linkedFabricDeviceId: null },
    { agentType: 'OMEGA', agentDeviceId: 'omega-elsewhere', displayName: 'Déjà lié', fingerprint: FP.omegaLinked, role: 'OMEGA_CLIENT', trust: 'TRUSTED', revokedAt: null, lastSessionAt: null, permissionLevel: 1, linkedFabricDeviceId: 'fdev-00000000-0000-4000-8000-000000000999' },
    { agentType: 'OMEGA', agentDeviceId: 'omega-revoked', displayName: 'Révoqué', fingerprint: FP.omegaRevoked, role: 'OMEGA_CLIENT', trust: 'REVOKED', revokedAt: now, lastSessionAt: null, permissionLevel: 3, linkedFabricDeviceId: null },
  ],
  RASSILON: [
    { agentType: 'RASSILON', agentDeviceId: 'rassilon-shared-key', displayName: 'Clé partagée', fingerprint: FP.shared, role: 'RASSILON_WORKER', trust: 'TRUSTED', revokedAt: null, lastSeenAt: null, linkedFabricDeviceId: null },
    { agentType: 'RASSILON', agentDeviceId: 'rassilon-gpu', displayName: 'GPU box', fingerprint: FP.worker, role: 'RASSILON_WORKER', trust: 'TRUSTED', revokedAt: null, lastSeenAt: now, linkedFabricDeviceId: null },
  ],
};

const devices = [];
const events = [];
let apiDown = false;
let rassilonRevoked = false;
let safeCpuAuthorized = false;
let nextRouteRejection = null;
const operations = [];
const calls = { create: 0, rename: 0, link: [], unlink: [], remove: [], route: [], probe: 0, devicesGets: 0, routeAttempts: 0 };
let internalError = false;
let abortNextRoute = false;

let presenceAgeMs = 1_000;
let sessionState = 'VALID';
let agentProjectionError = false;

function omegaLink() {
  const identity = agents.OMEGA[0];
  return {
    agentType: 'OMEGA', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'OK',
    trust: 'TRUSTED', availability: 'UNKNOWN', routable: false, routingStatus: 'NOT_ROUTABLE', routingReason: 'omega_outbound_client_not_implemented', identity,
    directions: [{ direction: 'REMOTE_ACTS_ON_THIS_PC', capabilities: [cap('OMEGA_VIEW', 'YES', 'YES', 'UNKNOWN'), cap('OMEGA_INTERACTIVE', 'YES', 'YES', 'UNKNOWN'), cap('OMEGA_ADMIN', 'YES', 'NO', 'UNKNOWN')] }],
  };
}

// Mirrors the server view: presence VERIFIED only inside the 30 s window,
// session state, routable only when all three capability values are YES.
function rassilonLink() {
  const identity = { ...agents.RASSILON[1], trust: rassilonRevoked ? 'REVOKED' : 'TRUSTED' };
  if (agentProjectionError) {
    return {
      agentType: 'RASSILON', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'AGENT_ERROR',
      trust: 'UNKNOWN', availability: 'ERROR', routable: false, routingStatus: 'NOT_AVAILABLE', routingReason: 'agent_projection_error', identity: null, directions: [],
    };
  }
  const expired = sessionState === 'EXPIRED';
  const presenceState = rassilonRevoked ? 'REVOKED' : presenceAgeMs <= 30_000 ? 'VERIFIED' : presenceAgeMs <= 90_000 ? 'STALE' : 'NOT_VERIFIED';
  const availability = rassilonRevoked || expired ? 'UNAVAILABLE' : presenceState === 'VERIFIED' ? 'AVAILABLE' : 'UNKNOWN';
  const value = authorized => (availability === 'UNAVAILABLE' || !authorized ? 'NO' : availability === 'AVAILABLE' ? 'YES' : 'UNKNOWN');
  const capability = (name, authorized) => {
    const a = rassilonRevoked || !authorized ? 'NO' : 'YES';
    const v = value(authorized && !rassilonRevoked);
    return { ...cap(name, 'YES', a, v), routable: a === 'YES' && v === 'YES' };
  };
  const capabilities = [capability('SAFE_CPU_TASK', safeCpuAuthorized), capability('EMBEDDING_BATCH', true)];
  const routable = capabilities.some(c => c.routable);
  const routingReason = routable ? null : rassilonRevoked ? 'rassilon_identity_revoked' : expired ? 'session_expired' : presenceState !== 'VERIFIED' ? 'presence_not_verified' : 'capability_not_authorized';
  return {
    agentType: 'RASSILON', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'OK',
    trust: identity.trust, availability, routable, routingStatus: routable ? 'READY' : 'NOT_AVAILABLE', routingReason, identity,
    directions: [{
      direction: 'THIS_PC_SENDS_COMPUTE', availability, capabilities,
      presence: { state: presenceState, lastVerifiedAt: new Date(Date.now() - presenceAgeMs).toISOString(), ageMs: presenceAgeMs, freshnessWindowMs: 30_000 },
      session: expired ? { state: 'EXPIRED', expiresAt: now, expiresInMs: 0 } : { state: sessionState, expiresAt: new Date(Date.now() + 600_000).toISOString(), expiresInMs: 600_000 },
    }],
  };
}

function newOperation(fabricDeviceId, actionType, status, extra = {}) {
  const op = {
    operationId: `fop-00000000-0000-4000-8000-00000000000${operations.length + 1}`, correlationId: `fcor-00000000-0000-4000-8000-00000000000${operations.length + 1}`,
    fabricDeviceId, agentType: 'RASSILON', agentDeviceId: 'rassilon-gpu', actionType, jobType: actionType === 'RASSILON_SAFE_CPU' ? 'SAFE_CPU_TASK' : 'EMBEDDING_BATCH',
    agentOperationId: status === 'NOT_AVAILABLE' ? null : `job-${operations.length + 1}`, status, inputSummary: {}, resultSummary: null, safeError: null,
    createdAt: now, startedAt: now, completedAt: null, updatedAt: now, pollsLeft: 1, ...extra,
  };
  operations.unshift(op);
  return op;
}

function operationsView() {
  for (const op of operations) {
    if (op.status !== 'RUNNING') continue;
    if (op.pollsLeft > 0) { op.pollsLeft -= 1; continue; }
    op.status = 'COMPLETED';
    op.completedAt = new Date(Date.parse(now) + 42).toISOString();
    op.resultSummary = op.jobType === 'SAFE_CPU_TASK'
      ? { kind: 'HASH_BUFFER', algorithm: 'sha256', inputBytes: 26, digest: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12' }
      : { kind: 'EMBEDDING_BATCH', model: '<script>window.__xssFired=true</script>', vectorCount: 2, dimensions: 768, durationMs: 12 };
  }
  return operations.map(({ pollsLeft: _p, ...op }) => op);
}

function stateOf(device) {
  const links = Object.values(device.agents).filter(Boolean).map(link => link.availability);
  if (links.length === 0) return 'UNKNOWN';
  const available = links.filter(a => a === 'AVAILABLE').length;
  if (available === links.length) return 'ONLINE';
  if (available > 0) return 'PARTIAL';
  if (links.every(a => a === 'UNAVAILABLE')) return 'OFFLINE';
  return 'UNKNOWN';
}

function view(device) {
  const agentsView = { OMEGA: device.links.OMEGA ? omegaLink() : null, RASSILON: device.links.RASSILON ? rassilonLink() : null };
  const out = { fabricDeviceId: device.fabricDeviceId, displayName: device.displayName, createdAt: now, updatedAt: now, agents: agentsView };
  return { ...out, state: stateOf(out) };
}

function agentsView() {
  const linked = new Map();
  for (const device of devices) for (const [type, id] of Object.entries(device.links)) if (id) linked.set(`${type}:${id}`, device.fabricDeviceId);
  const withLinks = list => list.map(identity => ({ ...identity, linkedFabricDeviceId: identity.linkedFabricDeviceId ?? linked.get(`${identity.agentType}:${identity.agentDeviceId}`) ?? null }));
  return { OMEGA: withLinks(agents.OMEGA), RASSILON: withLinks(agents.RASSILON) };
}

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-device-fabric',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/device-fabric-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5219, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });

  await page.route('**/api/device-fabric/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace('/api/device-fabric', '');
    const method = request.method();
    let status = 200;
    let body;
    const match = pathname.match(/^\/devices\/(fdev-[^/]+)(?:\/link(?:\/(OMEGA|RASSILON))?)?$/);
    const device = match ? devices.find(d => d.fabricDeviceId === match[1]) : null;

    if (pathname === '/devices' && method === 'GET') calls.devicesGets += 1;
    if (pathname === '/route' && method === 'POST') {
      calls.routeAttempts += 1;
      if (abortNextRoute) { abortNextRoute = false; await route.abort('failed'); return; }
    }

    if (apiDown) { status = 503; body = { ok: false, error: `<b>down</b>${XSS_IMG}` }; }
    else if (internalError && pathname === '/devices' && method === 'GET') { status = 500; body = { ok: false, error: 'internal_error' }; }
    else if (pathname === '/devices' && method === 'GET') body = { ok: true, devices: devices.map(view) };
    else if (pathname === '/agents') body = { ok: true, agents: agentsView(), agentErrors: agentProjectionError ? { RASSILON: 'agent_projection_error' } : {} };
    else if (pathname === '/audit') body = { ok: true, events };
    else if (pathname === '/operations' && method === 'GET') body = { ok: true, operations: operationsView() };
    else if (pathname === '/route' && method === 'POST') {
      const payload = request.postDataJSON();
      calls.route.push(payload);
      if (nextRouteRejection) {
        const op = newOperation(payload.fabricDeviceId, payload.actionType, 'NOT_AVAILABLE', { safeError: nextRouteRejection, completedAt: now });
        status = 409; body = { ok: false, error: nextRouteRejection, operation: op };
        nextRouteRejection = null;
      } else {
        status = 202; body = { ok: true, operation: newOperation(payload.fabricDeviceId, payload.actionType, 'RUNNING') };
      }
    } else if (/^\/devices\/fdev-[^/]+\/rassilon\/probe$/.test(pathname) && method === 'POST') {
      calls.probe += 1;
      body = { ok: true, device: view(devices.find(d => pathname.includes(d.fabricDeviceId))) };
    }
    else if (pathname === '/devices' && method === 'POST') {
      const { displayName } = request.postDataJSON();
      calls.create += 1;
      const created = { fabricDeviceId: `fdev-00000000-0000-4000-8000-00000000000${devices.length + 1}`, displayName, links: { OMEGA: null, RASSILON: null } };
      devices.push(created);
      events.unshift({ id: events.length + 1, createdAt: now, eventType: 'FABRIC_DEVICE_CREATED', fabricDeviceId: created.fabricDeviceId, agentType: null, agentDeviceId: null, reason: null });
      status = 201; body = { ok: true, device: view(created) };
    } else if (device && method === 'PATCH' && !match[2]) {
      calls.rename += 1; device.displayName = request.postDataJSON().displayName; body = { ok: true, device: view(device) };
    } else if (device && method === 'POST' && pathname.endsWith('/link')) {
      const payload = request.postDataJSON();
      calls.link.push(payload);
      if (payload.agentDeviceId === 'rassilon-shared-key') {
        status = 409; body = { ok: false, error: 'cross_agent_key_reuse' };
        events.unshift({ id: events.length + 1, createdAt: now, eventType: 'FABRIC_LINK_REJECTED', fabricDeviceId: device.fabricDeviceId, agentType: 'RASSILON', agentDeviceId: payload.agentDeviceId, reason: 'cross_agent_key_reuse' });
      } else {
        device.links[payload.agentType] = payload.agentDeviceId; body = { ok: true, device: view(device) };
      }
    } else if (device && method === 'DELETE' && match[2]) {
      calls.unlink.push(match[2]); device.links[match[2]] = null; body = { ok: true, device: view(device) };
    } else if (device && method === 'DELETE') {
      calls.remove.push(url.searchParams.get('confirm'));
      devices.splice(devices.indexOf(device), 1); body = { ok: true, removed: true };
    } else { status = 404; body = { ok: false, error: 'route_not_found' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/__device_fabric_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__device_fabric_test`);
  await page.getByRole('button', { name: 'OPEN DEVICES' }).click();
  await page.getByTestId('device-fabric-panel').waitFor();
  check(true, 'Devices page opens');
  await page.getByText(/Aucun appareil\./).waitFor();
  check(await page.getByText(/Aucun appareil\./).isVisible(), 'empty state');
  check(await page.getByText(/il n’accorde aucun droit OMEGA ni RASSILON/).isVisible(), 'no-authority notice');

  // Create + rename.
  await page.getByLabel('Nom du nouvel appareil').fill('PC Bureau');
  await page.getByRole('button', { name: /CREATE DEVICE/ }).click();
  await page.getByTestId('fabric-device-card').waitFor();
  check(calls.create === 1, 'create reached API');
  const card = page.getByTestId('fabric-device-card');
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'new device is UNKNOWN (no agent)');
  await card.getByRole('button', { name: /RENAME/ }).click();
  await card.getByLabel('Nouveau nom').fill('PC Salon');
  await card.getByRole('button', { name: /ENREGISTRER/ }).click();
  await card.getByText('PC Salon', { exact: true }).waitFor();
  check(calls.rename === 1, 'rename reached API');

  // OMEGA link dialog: only unlinked, non-revoked identities; full confirmation fields.
  await card.getByRole('button', { name: 'LINK OMEGA' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lier OMEGA' });
  await dialog.waitFor();
  const radios = dialog.getByRole('radio');
  check(await radios.count() === 1, 'OMEGA dialog lists only the unlinked, non-revoked identity');
  check(await dialog.getByText(/Déjà lié|Révoqué/).count() === 0, 'linked and revoked identities hidden');
  check(await dialog.getByText(XSS_IMG, { exact: false }).count() === 1, 'agent XSS name rendered as text');
  await radios.first().check();
  check(await dialog.getByTestId('fabric-link-fingerprint').innerText() === FP.omega, 'full fingerprint displayed');
  check(await dialog.getByText('PC Salon').isVisible() && await dialog.getByText('omega-laptop').isVisible(), 'fabric device + agent id displayed');
  const confirmLink = dialog.getByRole('button', { name: /CONFIRMER LE LIEN/ });
  check(await confirmLink.isDisabled(), 'link blocked until explicit fingerprint confirmation');
  await dialog.getByRole('checkbox').check();
  await confirmLink.click();
  await card.getByText(/Lié : OUI/).first().waitFor();
  check(calls.link[0].confirmFingerprint === FP.omega && calls.link[0].agentType === 'OMEGA', 'link sends explicit fingerprint confirmation');
  check(await card.getByText('Cet appareil peut agir sur ce PC').isVisible(), 'OMEGA direction label');
  check(await card.getByText('Disponibilité UNKNOWN').isVisible(), 'OMEGA availability UNKNOWN');
  check(await card.getByText(/Raison : OMEGA outbound client not implemented/).isVisible(), 'OMEGA: routing NOT AVAILABLE with explicit reason');
  check(await card.getByRole('button', { name: /VIEW|CONTROL|INTERACTIVE|ADMIN|SCREEN/i }).count() === 0, 'no OMEGA view/control button');
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'OMEGA-only device stays UNKNOWN, never ONLINE');

  // RASSILON: same-key conflict, then a valid worker.
  await card.getByRole('button', { name: 'LINK RASSILON' }).click();
  const rdialog = page.getByRole('dialog', { name: 'Lier RASSILON' });
  await rdialog.getByRole('radio').first().check();
  await rdialog.getByRole('checkbox').check();
  await rdialog.getByRole('button', { name: /CONFIRMER LE LIEN/ }).click();
  await page.getByRole('alert').getByText(/même clé existe dans OMEGA et RASSILON/).waitFor();
  check(true, 'same-key conflict shown as a safe error');
  check(await rdialog.isVisible(), 'dialog stays open after a rejected link');
  await rdialog.getByRole('radio').nth(1).check();
  await rdialog.getByRole('checkbox').check();
  await rdialog.getByRole('button', { name: /CONFIRMER LE LIEN/ }).click();
  await card.getByText('Overall PARTIAL').waitFor();
  check(true, 'PARTIAL state (OMEGA UNKNOWN + RASSILON AVAILABLE)');
  check(await card.getByText('Ce PC peut envoyer du calcul à cet appareil').isVisible(), 'RASSILON direction label');
  check(await card.getByText('READY — worker exact uniquement').isVisible(), 'RASSILON routing READY (exact worker)');
  const rows = await card.locator('tr').filter({ hasText: 'SAFE_CPU_TASK' }).innerText();
  check(/YES\s+NO\s+NO/.test(rows), `SUPPORTED/AUTHORIZED/AVAILABLE stay distinct (${rows})`);
  check(await card.getByText('Trust TRUSTED').count() === 2, 'OMEGA and RASSILON trust shown separately');
  check(await card.getByText(/DEVICE TRUSTED/).count() === 0, 'no global device trust');

  // ── Phase 3 routing ──
  check(calls.route.length === 0, 'nothing routed on load, link or refresh');
  const compute = card.getByRole('button', { name: 'CALCUL TEST' });
  check(await compute.isDisabled(), 'CALCUL TEST disabled while SAFE_CPU_TASK is not AUTHORIZED');
  await card.getByRole('button', { name: /VÉRIFIER LA DISPONIBILITÉ/ }).click();
  await page.getByText(/Disponibilité vérifiée/).waitFor();
  check(calls.probe === 1 && calls.route.length === 0, 'probe is explicit and never routes');
  safeCpuAuthorized = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'CALCUL TEST' && !b.disabled));
  await compute.click();
  check(await card.getByText(/envoyé uniquement à : GPU box/).isVisible(), 'confirmation names the exact worker');
  check(calls.route.length === 0, 'first click only asks for confirmation');
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByTestId('fabric-operations').getByText('COMPLETED').waitFor({ timeout: 10_000 });
  const routed = calls.route[0];
  check(JSON.stringify(Object.keys(routed).sort()) === '["actionType","fabricDeviceId","semanticPayload"]', `strict route body ${JSON.stringify(routed)}`);
  check(routed.actionType === 'RASSILON_SAFE_CPU' && routed.semanticPayload.kind === 'HASH_BUFFER', 'fixed SAFE_CPU_TASK payload');
  const opRow = await page.getByTestId('fabric-operations').locator('tr').nth(1).innerText();
  check(/PC Salon/.test(opRow) && /CALCUL TEST/.test(opRow) && /42 ms/.test(opRow) && /sha256 ab12cd34/.test(opRow), `operation row: target, action, duration, safe summary (${opRow})`);

  await card.getByRole('button', { name: 'EMBEDDINGS' }).click();
  const embed = card.getByLabel('Embeddings RASSILON');
  check(await embed.getByText(/16 textes, 2000 caractères par texte, 16000 au total/).isVisible(), 'embedding limits visible');
  check(await embed.getByText(/aucun cloud, aucun téléchargement/).isVisible(), 'local-only notice');
  await embed.getByLabel('Textes à vectoriser (un par ligne)').fill(Array.from({ length: 17 }, (_, i) => `ligne ${i}`).join('\n'));
  check(await embed.getByText('Au plus 16 textes.').isVisible(), 'frontend validation message');
  check(await embed.getByRole('button', { name: /ENVOYER LES EMBEDDINGS/ }).isDisabled(), 'invalid batch cannot be sent');
  await embed.getByLabel('Textes à vectoriser (un par ligne)').fill('premier texte\nsecond texte');
  await embed.getByRole('button', { name: /ENVOYER LES EMBEDDINGS/ }).click();
  await embed.getByRole('button', { name: /CONFIRMER L’ENVOI/ }).click();
  await page.getByTestId('fabric-operations').getByText(/2 vecteur\(s\) × 768/).waitFor({ timeout: 10_000 });
  const embedCall = calls.route[1];
  check(embedCall.actionType === 'RASSILON_EMBEDDING' && JSON.stringify(embedCall.semanticPayload) === JSON.stringify({ texts: ['premier texte', 'second texte'], model: 'nomic-embed-text' }), 'embedding request is exactly texts + allowlisted model');
  check(await page.getByTestId('fabric-operations').getByText(/<script>window.__xssFired=true<\/script>/).count() === 1, 'model name from a result rendered as inert text');

  nextRouteRejection = 'target_availability_unknown';
  await compute.click();
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByRole('alert').getByText(/disponibilité inconnue/).waitFor();
  check(await page.getByTestId('fabric-operations').getByText('NOT_AVAILABLE').count() >= 1, 'NOT_AVAILABLE operation shown, never COMPLETED');
  check(calls.route.length === 3, 'exactly one request per explicit confirmation');

  // ── Phase 4: freshness, session, failures, no retry, projection errors ──
  check(await card.getByText('Présence VERIFIED', { exact: true }).isVisible() && await card.getByText('Session VALID', { exact: true }).isVisible(), 'presence VERIFIED + session VALID shown');
  check(await card.getByText(/fraîcheur 1 s \/ fenêtre 30 s/).isVisible(), 'probe freshness and window shown');
  check(await page.getByRole('button', { name: /CANCEL|ANNULER L/i }).count() === 0, 'no cancel button (no certified primitive)');
  check(await page.getByText(/Annulation depuis ce PC : indisponible en V1/).isVisible(), 'cancellation limitation documented in the UI');

  presenceAgeMs = 26_000;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'CALCUL TEST' && !b.disabled));
  const readsBefore = calls.devicesGets;
  const probesBefore = calls.probe;
  await card.getByText('Présence STALE', { exact: true }).waitFor({ timeout: 10_000 });
  check(calls.devicesGets === readsBefore && calls.probe === probesBefore, 'display aging needs no network call (no heartbeat, no probe)');
  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled(), 'stale presence → routing disabled');
  check(await card.getByText('Disponibilité UNKNOWN').count() >= 1, 'AVAILABLE turns UNKNOWN after the freshness window');
  check(await card.getByText(/présence non vérifiée récemment/).isVisible(), 'stale reason shown');
  presenceAgeMs = 1_000;

  sessionState = 'EXPIRED';
  await page.getByRole('button', { name: /REFRESH/ }).click();

  await card.getByText('Session EXPIRED', { exact: true }).waitFor();
  check(await card.getByText(/SESSION EXPIRED — refaire le pairing dans RASSILON/).isVisible(), 'expired session: explicit reason, no renewal');
  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled() && await card.getByRole('button', { name: 'EMBEDDINGS' }).isDisabled(), 'expired session → routing disabled');
  sessionState = 'VALID';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Session VALID', { exact: true }).waitFor();

  abortNextRoute = true;
  const attemptsBefore = calls.routeAttempts;
  await compute.click();
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByRole('alert').getByText(/injoignable/).waitFor();
  await page.waitForTimeout(1_500);
  check(calls.routeAttempts === attemptsBefore + 1, `network failure → exactly one route attempt, no retry (${calls.routeAttempts - attemptsBefore})`);

  newOperation(devices[0].fabricDeviceId, 'RASSILON_SAFE_CPU', 'FAILED', { safeError: 'result_schema_invalid', completedAt: now });
  newOperation(devices[0].fabricDeviceId, 'RASSILON_EMBEDDING', 'FAILED', { safeError: 'interrupted_by_restart', completedAt: now });
  newOperation(devices[0].fabricDeviceId, 'RASSILON_SAFE_CPU', 'FAILED', { safeError: XSS_IMG, completedAt: now });
  events.unshift({ id: 900, createdAt: now, eventType: 'FABRIC_ROUTE_REJECTED', fabricDeviceId: devices[0].fabricDeviceId, agentType: 'OMEGA', agentDeviceId: 'javascript:alert(1)', reason: '<script>window.__xssFired=true</script>' });
  await page.getByRole('button', { name: /REFRESH/ }).click();
  const opsTable = page.getByTestId('fabric-operations');
  await opsTable.getByText(/résultat non conforme/).waitFor();
  check(await opsTable.getByText(/interrompue par un redémarrage \(non reprise\)/).isVisible(), 'restart-interrupted operation shown as such, never COMPLETED');
  check(await opsTable.getByText(XSS_IMG, { exact: false }).count() === 1, 'operation error rendered as inert text');
  check(await page.getByText('<script>window.__xssFired=true</script>', { exact: true }).count() >= 1, 'audit reason rendered as inert text');

  agentProjectionError = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText(/illisible \(projection en erreur\) : rien n’est supposé/).waitFor();
  check(await page.getByText(/Projection RASSILON illisible/).isVisible(), 'agent projection error banner');
  check(await card.getByText('Overall ERROR').isVisible(), 'projection error → overall ERROR, never ONLINE');
  check(await card.getByTestId('rassilon-actions').count() === 0, 'no routing action on a link in error');
  agentProjectionError = false;

  internalError = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByRole('alert').getByText(/Erreur interne Device Fabric/).waitFor();
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'Fabric DB error → UNKNOWN');
  internalError = false;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Overall PARTIAL').waitFor();

  // Revoked RASSILON identity.
  rassilonRevoked = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Trust REVOKED').waitFor();
  check(await card.getByText('Trust TRUSTED').count() === 1, 'OMEGA stays TRUSTED while RASSILON is REVOKED');
  check(await card.getByText('Disponibilité UNAVAILABLE').isVisible(), 'revoked → AVAILABLE = NO');

  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled() && await card.getByRole('button', { name: 'EMBEDDINGS' }).isDisabled(), 'revoked worker → routing actions disabled');

  // No generic control actions at all.
  const buttons = await page.getByRole('button').allInnerTexts();
  check(!buttons.some(text => /FULL CONTROL|CONTROL DEVICE|\bRUN\b|ROUTE|DISPATCH|EXECUTE|COMMAND|VIEW SCREEN|REVOKE|PAIR|STOP|ENABLE/i.test(text)), `only Phase 3 actions (${buttons.join(' | ')})`);

  // Unlink OMEGA (explicit two-step).
  await card.getByRole('button', { name: 'UNLINK OMEGA' }).click();
  await card.getByRole('button', { name: 'CONFIRMER UNLINK OMEGA' }).click();
  await card.getByRole('button', { name: 'LINK OMEGA' }).waitFor();
  check(calls.unlink.join() === 'OMEGA', 'unlink reached API for OMEGA only');

  // XSS: Fabric display name and error reasons from the API.
  devices[0].displayName = '<script>window.__xssFired=true</script>';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('<script>window.__xssFired=true</script>').waitFor();
  const active = await page.getByTestId('device-fabric-panel').evaluate(root => ({
    img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, bold: root.querySelectorAll('b').length,
  }));
  check(active.img === 0 && active.script === 0 && active.bold === 0, `no active HTML from Fabric data ${JSON.stringify(active)}`);

  // javascript: URLs, HTML entities, bidi controls and very long Unicode names.
  const longName = 'javascript:alert(1) &lt;img src=x onerror=1&gt; ‮evil ' + '𝔘'.repeat(400);
  devices[0].displayName = longName;
  agents.RASSILON[1].displayName = `&amp;&lt;b&gt;${'é'.repeat(500)}`;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText(/^javascript:alert\(1\) &lt;img src=x onerror=1&gt;/).waitFor();
  const rendered = await card.evaluate(root => ({
    links: root.querySelectorAll('a, [href], [src]').length,
    bidi: /[‪-‮⁦-⁩]/.test(root.textContent),
    longest: Math.max(...[...root.querySelectorAll('strong, p')].map(el => el.textContent.length)),
    entitiesDecoded: root.querySelectorAll('b, img').length,
  }));
  check(rendered.links === 0 && !rendered.bidi && rendered.entitiesDecoded === 0, `javascript:/entities/bidi inert ${JSON.stringify(rendered)}`);
  check(rendered.longest < 400, `long Unicode names are truncated (${rendered.longest})`);
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS fired from long/unicode/entity names');
  agents.RASSILON[1].displayName = 'GPU box';

  // Delete with links requires explicit confirmation and says nothing is revoked.
  await card.getByRole('button', { name: 'DELETE' }).click();
  check(await card.getByText(/ne révoque ni OMEGA ni RASSILON/).isVisible(), 'delete warns agents are not revoked');
  await card.getByRole('button', { name: 'CONFIRMER DELETE' }).click();
  await page.getByText(/Aucun appareil\./).waitFor();
  check(calls.remove.join() === 'REMOVE_LINKS', 'delete with links sends explicit confirmation');

  // API unreachable → UNKNOWN, alert, actions disabled; XSS in the error inert.
  await page.getByLabel('Nom du nouvel appareil').fill('Laptop');
  await page.getByRole('button', { name: /CREATE DEVICE/ }).click();
  await page.getByTestId('fabric-device-card').waitFor();
  rassilonRevoked = false;
  devices[0].links.RASSILON = 'rassilon-gpu';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByText('Overall ONLINE').waitFor();
  check(true, 'ONLINE only with a fresh AVAILABLE agent');
  apiDown = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByRole('alert').waitFor();
  check(await page.getByRole('alert').getByText(/injoignable/).isVisible(), 'API error state visible');
  check(await page.getByText('Overall UNKNOWN').isVisible(), 'unreachable API → UNKNOWN');
  check(await page.getByText('Overall ONLINE').count() === 0, 'stale ONLINE not shown when API unreachable');
  check(await page.getByText('Disponibilité AVAILABLE').count() === 0 && await page.getByText('Trust TRUSTED').count() === 0, 'stale agent states replaced by UNKNOWN');
  check(await page.getByRole('button', { name: /CREATE DEVICE/ }).isDisabled(), 'mutating actions disabled while unreachable');
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS fired anywhere');
  check(pageErrors.length === 0, `page errors: ${pageErrors.join(', ')}`);
  console.log(`DEVICE FABRIC BROWSER PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
