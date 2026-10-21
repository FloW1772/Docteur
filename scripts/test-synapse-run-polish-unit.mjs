// [GAME-6] Synapse Run — synthesised audio engine (fake AudioContext with node tracking) and simulation-derived
// feedback events. Deterministic, no browser, no speakers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HISTORY_LENGTH, MAX_UNLOCK_ATTEMPTS, MAX_VOICES, createAudioEngine } from '../src/arcade/synapse-run/audio.ts';
import { feedbackEvents, feedbackView } from '../src/arcade/synapse-run/feedback.ts';
import { LANE_CHANGE_TICKS, SLIDE_TICKS, SPEED, TICK_RATE, checksum, createSim, stepSim } from '../src/arcade/synapse-run/simulation.ts';

/** Tracks every node; `end()` fires the pending onended callbacks like the browser would after stop time. */
function fakeAudio({ state = 'running', resume = async () => {} } = {}) {
  const nodes = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = kind => { const n = { kind, connected: 0, disconnected: 0, connect() { this.connected++; }, disconnect() { this.disconnected++; } }; nodes.push(n); return n; };
  const ctx = {
    currentTime: 0, state, destination: { kind: 'destination' }, closed: 0, resumes: 0,
    createOscillator() { const o = Object.assign(node('osc'), { type: '', frequency: param(), started: 0, stopped: 0, onended: null, start() { this.started++; }, stop() { this.stopped++; } }); return o; },
    createGain() { return Object.assign(node('gain'), { gain: param() }); },
    resume() { this.resumes++; return resume(this); },
    async close() { this.closed++; this.state = 'closed'; },
  };
  const end = () => { for (const n of nodes) if (n.kind === 'osc' && n.onended) n.onended(); };
  return { ctx, nodes, end };
}

test('audio is locked and silent before any gesture: no AudioContext is created', () => {
  let created = 0;
  const audio = createAudioEngine(() => { created++; return fakeAudio().ctx; });
  assert.deepEqual([audio.state, audio.unlockAttempts], ['locked', 0]);
  assert.equal(audio.play('jump'), false);
  assert.equal(created, 0);
});

test('a gesture unlocks; effects play, end and are fully disconnected', async () => {
  const f = fakeAudio();
  const audio = createAudioEngine(() => f.ctx);
  audio.unlock();
  assert.equal(audio.state, 'running');
  for (const effect of ['jump', 'shard', 'crash', 'mission', 'lane', 'slide', 'ui']) assert.equal(audio.play(effect), true, effect);
  assert.deepEqual(audio.history(), ['jump', 'shard', 'crash', 'mission', 'lane', 'slide', 'ui']);
  assert.ok(audio.activeVoices > 0 && audio.activeVoices <= MAX_VOICES);
  f.end();
  assert.equal(audio.activeVoices, 0);
  const oscillators = f.nodes.filter(n => n.kind === 'osc');
  assert.ok(oscillators.every(o => o.started === 1 && o.stopped === 1 && o.disconnected >= 1 && o.onended === null));
  const voiceGains = f.nodes.filter(n => n.kind === 'gain').slice(1);
  assert.ok(voiceGains.every(g => g.disconnected >= 1), 'every voice gain released');
  audio.unlock();
  assert.equal(f.ctx.resumes, 1, 'idempotent once running');
});

test('mute stops sounding voices and every future effect; unmute restores', () => {
  const f = fakeAudio();
  const audio = createAudioEngine(() => f.ctx);
  audio.unlock();
  audio.play('crash');
  assert.ok(audio.activeVoices > 0);
  audio.setMuted(true);
  assert.deepEqual([audio.muted, audio.activeVoices], [true, 0]);
  assert.equal(audio.play('jump'), false);
  audio.setMuted(false);
  assert.equal(audio.play('jump'), true);
});

test('no AudioContext, or a throwing constructor: permanently silent, never retried', () => {
  let calls = 0;
  const missing = createAudioEngine(() => { calls++; return null; });
  missing.unlock(); missing.unlock(); missing.unlock();
  assert.deepEqual([missing.state, calls, missing.play('jump')], ['unavailable', 1, false]);
  const throwing = createAudioEngine(() => { throw new Error('NotSupportedError'); });
  throwing.unlock();
  assert.deepEqual([throwing.state, throwing.play('shard')], ['unavailable', false]);
});

test('resume rejection: blocked, retried only on later gestures, at most MAX_UNLOCK_ATTEMPTS', async () => {
  const f = fakeAudio({ state: 'suspended', resume: () => Promise.reject(new Error('NotAllowedError')) });
  const audio = createAudioEngine(() => f.ctx);
  for (let i = 0; i < 10; i++) { audio.unlock(); await new Promise(r => setImmediate(r)); }
  assert.equal(f.ctx.resumes, MAX_UNLOCK_ATTEMPTS);
  assert.deepEqual([audio.state, audio.play('jump')], ['blocked', false]);
});

test('a pending resume stays silent until it resolves', async () => {
  let resolveResume;
  const f = fakeAudio({ state: 'suspended', resume: ctx => new Promise(r => { resolveResume = () => { ctx.state = 'running'; r(); }; }) });
  const audio = createAudioEngine(() => f.ctx);
  audio.unlock();
  assert.deepEqual([audio.state, audio.play('jump')], ['locked', false]);
  resolveResume();
  await new Promise(r => setImmediate(r));
  assert.deepEqual([audio.state, audio.play('jump')], ['running', true]);
});

test('voice cap and no accumulation over many triggers; bounded history', () => {
  const f = fakeAudio();
  const audio = createAudioEngine(() => f.ctx);
  audio.unlock();
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (audio.play('lane')) accepted++;
  assert.equal(accepted, MAX_VOICES, 'extra effects dropped, never queued');
  assert.equal(audio.play('mission'), true, 'important effects take the oldest voices instead of being dropped');
  assert.equal(audio.activeVoices, MAX_VOICES);
  assert.equal(audio.play('crash'), true);
  assert.equal(audio.activeVoices, MAX_VOICES);
  f.end();
  for (let round = 0; round < 50; round++) { audio.play('shard'); f.end(); }
  assert.equal(audio.activeVoices, 0);
  assert.equal(audio.history().length, HISTORY_LENGTH);
});

test('dispose stops and disconnects everything, closes the context once, then stays closed', () => {
  const f = fakeAudio();
  const audio = createAudioEngine(() => f.ctx);
  audio.unlock();
  audio.play('mission');
  audio.dispose();
  audio.dispose();
  assert.deepEqual([audio.state, audio.activeVoices, f.ctx.closed], ['closed', 0, 1]);
  assert.equal(f.nodes[0].disconnected >= 1, true, 'master gain disconnected');
  audio.unlock();
  assert.deepEqual([audio.state, audio.play('jump'), f.ctx.resumes], ['closed', false, 1]);
});

test('audio source: synthesised only, no files, no network', () => {
  const source = fs.readFileSync(new URL('../src/arcade/synapse-run/audio.ts', import.meta.url), 'utf8');
  for (const forbidden of [/fetch\(/, /new Audio\(/, /\.(mp3|ogg|wav|m4a|flac)\b/, /https?:\/\//, /decodeAudioData/, /XMLHttpRequest/]) assert.equal(forbidden.test(source), false, String(forbidden));
});

// ── feedback events ─────────────────────────────────────────────────────────────────────────────────────
function fixture(extra = {}) {
  const s = createSim(1);
  s.obstacles = []; s.shards = []; s.nextRowZ = 1e9; Object.assign(s, extra);
  return s;
}
const stepWithEvents = (s, commands = []) => { const before = feedbackView(s); stepSim(s, commands); return feedbackEvents(before, feedbackView(s)); };

test('feedback: START, LANE (also buffered), JUMP, SLIDE, SHARD, CRASH — once each, in order', () => {
  const s = fixture();
  assert.deepEqual(stepWithEvents(s, ['START']), ['START']);
  assert.deepEqual(stepWithEvents(s, ['LEFT', 'RIGHT']), ['LANE'], 'LEFT starts, RIGHT is buffered');
  const later = [];
  for (let i = 0; i < LANE_CHANGE_TICKS; i++) later.push(...stepWithEvents(s));
  assert.deepEqual(later, ['LANE'], 'the buffered change is its own LANE event');
  for (let i = 0; i < LANE_CHANGE_TICKS; i++) stepWithEvents(s);
  assert.deepEqual(stepWithEvents(s, ['JUMP']), ['JUMP']);
  assert.deepEqual(stepWithEvents(s, ['JUMP']), [], 'no event for an ignored double jump');
  while (s.mode === 'JUMP') stepWithEvents(s);
  assert.deepEqual(stepWithEvents(s, ['SLIDE']), ['SLIDE']);
  for (let i = 0; i < SLIDE_TICKS; i++) stepWithEvents(s, ['SLIDE']);
  const shard = fixture({ status: 'RUNNING', shards: [{ id: 9, lane: 1, z: 2, collected: false }] });
  const shardEvents = [];
  for (let i = 0; i < 20; i++) shardEvents.push(...stepWithEvents(shard));
  assert.deepEqual(shardEvents, ['SHARD']);
  const crash = fixture({ status: 'RUNNING', obstacles: [{ id: 5, type: 'BLOCK', lane: 1, z: 3 }] });
  const crashEvents = [];
  for (let i = 0; i < 40; i++) crashEvents.push(...stepWithEvents(crash));
  assert.deepEqual(crashEvents, ['CRASH']);
});

test('deriving feedback never changes the simulation (same checksum with and without it)', () => {
  const inputs = t => (t % 37 === 0 ? ['LEFT'] : t % 53 === 0 ? ['JUMP'] : t % 71 === 0 ? ['RIGHT'] : t % 89 === 0 ? ['SLIDE'] : []);
  const plain = createSim(20261021), observed = createSim(20261021);
  stepSim(plain, ['START']); stepSim(observed, ['START']);
  let events = 0;
  for (let t = 0; t < 3000; t++) { stepSim(plain, inputs(t)); events += stepWithEvents(observed, inputs(t)).length; }
  assert.equal(checksum(observed), checksum(plain));
  assert.ok(events > 10);
  assert.deepEqual([SPEED, TICK_RATE, LANE_CHANGE_TICKS, SLIDE_TICKS], [12, 60, 8, 36], 'GAME-4 constants frozen');
});
