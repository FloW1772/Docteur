// [LOAD-1/LOAD-2] Boot readiness poller (src/lib/startup/readiness.ts, Node type stripping) with a fake clock and
// hand-resolved probes — no real waiting. Proves the state machine (STARTING → WAITING → DELAYED → FAILED / READY),
// one sequential loop, Retry semantics, stale answers dropped, READY terminal, cleanup on stop, and the probe contract.
// Usage: node --test scripts/test-startup-screen-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STARTUP_POLICY, backendPingUrl, createReadinessPoller, nextProbeDelayMs, phaseAfterMiss, probeBackend,
} from '../src/lib/startup/readiness.ts';
import { STARTUP_TEXT, outcomeText } from '../src/lib/startup/startup-text.ts';

const flush = () => new Promise((r) => setImmediate(r));

/** Fake clock + timers + probes the test answers one by one. */
function rig({ policy } = {}) {
  let t = 1_000;
  let nextId = 1;
  const timers = new Map();
  const states = [];
  const probes = [];
  let maxInFlight = 0;
  const inFlight = () => probes.filter((p) => !p.settled).length;
  const poller = createReadinessPoller({
    policy,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    onChange: (s) => states.push(s),
    probe: (signal) => new Promise((resolve, reject) => {
      const p = { signal, settled: false, resolve: (o) => { p.settled = true; resolve(o); }, reject: (e) => { p.settled = true; reject(e); } };
      probes.push(p);
      maxInFlight = Math.max(maxInFlight, inFlight());
    }),
  });
  return {
    poller, states, probes, timers,
    get now() { return t; },
    get maxInFlight() { return maxInFlight; },
    last: () => states.at(-1),
    /** Answers the pending probe, then lets the poller react. */
    async answer(outcome) { const p = probes.findLast((x) => !x.settled); assert.ok(p, 'a probe is pending'); p.resolve(outcome); await flush(); },
    /** Moves the clock forward and fires the timers that became due (in order). */
    async advance(ms) {
      t += ms;
      for (const [id, tm] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (tm.at <= t && timers.has(id)) { timers.delete(id); tm.fn(); await flush(); }
      }
    },
    /** Fail every probe until the clock passes `until` (each answered as `outcome`). */
    async missUntil(until, outcome = { kind: 'unreachable' }) {
      while (probes.some((p) => !p.settled)) {
        await this.answer(outcome); // the phase is decided when a check completes, so the last answer lands at/after `until`
        const [first] = [...timers.values()];
        if (t >= until || !first) break;
        await this.advance(first.at - t);
      }
    },
  };
}

test('policy: probe backoff unchanged from the pre-LOAD gate, phase thresholds = 15 s delayed / 120 s failed (launcher budget)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(nextProbeDelayMs), [800, 1280, 2048, 3277, 5000, 5000, 5000]);
  assert.equal(STARTUP_POLICY.probeTimeoutMs, 2_000);
  assert.equal(STARTUP_POLICY.delayedAfterMs, 15_000);
  assert.equal(STARTUP_POLICY.failAfterMs, 120_000);
  assert.equal(phaseAfterMiss(0), 'WAITING');
  assert.equal(phaseAfterMiss(14_999), 'WAITING');
  assert.equal(phaseAfterMiss(15_000), 'DELAYED');
  assert.equal(phaseAfterMiss(119_999), 'DELAYED');
  assert.equal(phaseAfterMiss(120_000), 'FAILED');
  const wait = fs.readFileSync('scripts/wait-for-cortex.mjs', 'utf8');
  assert.ok(/Date\.now\(\) - started < 120000/.test(wait), 'FAILED budget mirrors the launcher wait (120 s)');
});

test('A. backend already ready: STARTING then READY after one probe, nothing scheduled afterwards', async () => {
  const r = rig();
  r.poller.start();
  assert.equal(r.last().phase, 'STARTING');
  assert.equal(r.probes.length, 1, 'first check is immediate');
  await r.answer({ kind: 'ready' });
  assert.equal(r.last().phase, 'READY');
  assert.equal(r.last().attempts, 1);
  assert.equal(r.timers.size, 0, 'no timer left');
  assert.deepEqual(r.states.map((s) => s.phase), ['STARTING', 'READY']);
});

test('B. ready after several refused probes: WAITING between them, one probe at a time, then READY', async () => {
  const r = rig();
  r.poller.start();
  for (let i = 0; i < 3; i++) {
    await r.answer({ kind: 'unreachable' });
    assert.equal(r.last().phase, 'WAITING');
    assert.equal(r.timers.size, 1, 'exactly one next check scheduled');
    const [tm] = [...r.timers.values()];
    await r.advance(tm.at - r.now);
  }
  await r.answer({ kind: 'ready' });
  assert.equal(r.last().phase, 'READY');
  assert.equal(r.last().attempts, 4);
  assert.equal(r.maxInFlight, 1, 'never two concurrent health requests');
  assert.equal(r.probes.length, 4);
});

test('C. slower than expected: DELAYED once 15 s have passed, polling continues', async () => {
  const r = rig();
  r.poller.start();
  await r.missUntil(r.now + 15_000);
  assert.equal(r.last().phase, 'DELAYED');
  assert.equal(r.timers.size, 1, 'still polling');
  assert.ok(r.states.some((s) => s.phase === 'WAITING'), 'WAITING came first');
  assert.ok(!r.states.some((s) => s.phase === 'FAILED'));
});

test('D. never ready: FAILED after the 120 s budget, then polling stops (no timer, no new probe)', async () => {
  const r = rig();
  r.poller.start();
  await r.missUntil(r.now + 200_000);
  assert.equal(r.last().phase, 'FAILED');
  assert.ok(r.last().lastCheckAt - r.last().startedAt >= 120_000);
  const probes = r.probes.length;
  assert.equal(r.timers.size, 0);
  await r.advance(60_000);
  assert.equal(r.probes.length, probes, 'no probe after FAILED');
  assert.ok(probes <= 40, `bounded number of checks (${probes})`);
});

test('E. Retry after FAILED runs a fresh check with a fresh budget and can reach READY; Retry is ignored otherwise', async () => {
  const r = rig();
  r.poller.start();
  r.poller.retry();
  assert.equal(r.probes.length, 1, 'Retry while STARTING is ignored');
  await r.missUntil(r.now + 200_000, { kind: 'timeout' });
  assert.equal(r.last().phase, 'FAILED');
  assert.equal(r.last().lastOutcome.kind, 'timeout');
  const before = r.probes.length;
  r.poller.retry();
  assert.equal(r.last().phase, 'STARTING');
  assert.equal(r.last().attempts, 0);
  assert.equal(r.last().startedAt, r.now, 'fresh budget');
  assert.equal(r.probes.length, before + 1, 'Retry re-runs the readiness check immediately');
  r.poller.retry();
  assert.equal(r.probes.length, before + 1, 'a second click while checking is ignored');
  await r.answer({ kind: 'ready' });
  assert.equal(r.last().phase, 'READY');
});

test('F. stale answers: a late failure from an older run never replaces READY, and READY is terminal', async () => {
  // (a) a stopped run (React StrictMode mounts → unmounts → mounts) answers late with a failure after the new run is READY
  const r = rig();
  const oldPoller = r.poller;
  oldPoller.start();
  const stale = r.probes[0];
  oldPoller.stop();
  assert.equal(stale.signal.aborted, true, 'stop aborts the in-flight request');
  const r2 = rig();
  r2.poller.start();
  await r2.answer({ kind: 'ready' });
  const seen = r.states.length;
  stale.resolve({ kind: 'unreachable' });
  await flush();
  assert.equal(r.states.length, seen, 'the stopped run emitted nothing after stop');
  assert.equal(r2.last().phase, 'READY');
  // (b) within one run: after READY nothing can be emitted, and Retry/start are no-ops
  r2.poller.retry();
  r2.poller.start();
  await r2.advance(300_000);
  assert.deepEqual(r2.states.map((s) => s.phase), ['STARTING', 'READY']);
  // (c) a Retry supersedes an older run's late answer
  const r3 = rig();
  r3.poller.start();
  await r3.missUntil(r3.now + 200_000);
  r3.poller.retry();
  const fresh = r3.probes.at(-1);
  fresh.resolve({ kind: 'ready' });
  await flush();
  assert.equal(r3.last().phase, 'READY');
});

test('G. stop(): clears the pending timer, aborts the in-flight probe, emits nothing more (unmount cleanup)', async () => {
  const r = rig();
  r.poller.start();
  await r.answer({ kind: 'unreachable' });
  assert.equal(r.timers.size, 1);
  r.poller.stop();
  assert.equal(r.timers.size, 0, 'timer cleared');
  const emitted = r.states.length;
  await r.advance(60_000);
  assert.equal(r.states.length, emitted);
  const r2 = rig();
  r2.poller.start();
  r2.poller.stop();
  assert.equal(r2.probes[0].signal.aborted, true);
  r2.probes[0].resolve({ kind: 'ready' });
  await flush();
  assert.equal(r2.last().phase, 'STARTING', 'a late READY after unmount is ignored too');
  r2.poller.start();
  assert.equal(r2.probes.length, 1, 'start after stop does not open a second loop');
});

test('a throwing probe counts as unreachable (never crashes the loop)', async () => {
  const r = rig();
  r.poller.start();
  r.probes[0].reject(new Error('boom C:\\secret\\path'));
  await flush();
  assert.equal(r.last().phase, 'WAITING');
  assert.deepEqual(r.last().lastOutcome, { kind: 'unreachable' });
});

test('probeBackend: ready only on 200 + { ok: true }; status, body, timeout and caller abort are classified', async () => {
  const res = (status, body) => ({ status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
  const run = (impl, extra = {}) => probeBackend(new AbortController().signal, { url: 'http://x/api/ping', fetchImpl: impl, ...extra });
  assert.deepEqual(await run(async () => res(200, { ok: true })), { kind: 'ready' });
  assert.deepEqual(await run(async () => res(200, { ok: false })), { kind: 'unexpected', status: 200 });
  assert.deepEqual(await run(async () => res(200, 'not json')), { kind: 'unexpected', status: 200 });
  assert.deepEqual(await run(async () => res(404, { error: 'Route introuvable' })), { kind: 'unexpected', status: 404 });
  assert.deepEqual(await run(async () => res(503, {})), { kind: 'unexpected', status: 503 });
  assert.deepEqual(await run(async () => { throw new TypeError('Failed to fetch'); }), { kind: 'unreachable' });
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  assert.deepEqual(await run(hang, { timeoutMs: 20 }), { kind: 'timeout' });
  const caller = new AbortController();
  const p = probeBackend(caller.signal, { url: 'http://x/api/ping', fetchImpl: hang, timeoutMs: 10_000 });
  caller.abort();
  assert.deepEqual(await p, { kind: 'unreachable' }, 'aborted by the caller ≠ timeout');
  let init;
  await run(async (_u, i) => { init = i; return res(200, { ok: true }); });
  assert.equal(init.cache, 'no-store');
  assert.equal(Object.keys(init).sort().join(','), 'cache,signal', 'no method/headers/credentials/body added');
  assert.equal(backendPingUrl({ protocol: 'http:', hostname: 'localhost' }), 'http://localhost:3001/api/ping');
});

test('texts: French, no URL / path / stack / percentage in any state message', () => {
  const all = [...Object.values(STARTUP_TEXT), ...[{ kind: 'unreachable' }, { kind: 'timeout' }, { kind: 'unexpected', status: 503 }].map(outcomeText)];
  for (const t of all) {
    assert.ok(!/https?:|[A-Z]:\\|\/api\/|%|Error|at \w+ \(/.test(t), `safe text: ${t}`);
  }
  assert.equal(outcomeText(null), null);
  assert.equal(STARTUP_TEXT.delayed, 'Docteur met plus de temps que prévu à démarrer.');
  assert.equal(STARTUP_TEXT.offline, 'Ouvrir la copie hors ligne', 'label kept (production PWA test clicks it)');
  assert.ok(STARTUP_TEXT.waiting.startsWith('Connexion au serveur en cours'), 'phrase kept (startup-gate test looks for it)');
});

test('static: no fake progress, no process/command capability, ServerStartup delegates to the gate', () => {
  const gate = fs.readFileSync('src/components/startup/StartupGate.tsx', 'utf8');
  const lib = fs.readFileSync('src/lib/startup/readiness.ts', 'utf8');
  const entry = fs.readFileSync('src/ServerStartup.tsx', 'utf8');
  for (const raw of [gate, lib]) {
    const src = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // code only — the comments do talk about these
    assert.ok(!/\bpercent|%\}|progress=|<progress|aria-valuenow/i.test(src), 'no percentage / determinate progress');
    assert.ok(!/child_process|spawn|exec\(|\/api\/runtime|restart|location\.reload|eval\(/.test(src), 'no process start, restart, reload or eval');
  }
  assert.ok(!/fetch\(/.test(gate), 'the component never fetches by itself (only through the probe)');
  assert.equal((lib.match(/fetchImpl\(/g) ?? []).length, 1, 'one request site');
  assert.ok(entry.includes('<StartupGate renderReady={renderApp} />'));
});
