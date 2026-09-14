import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/lib/video-job-polling.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020}}).outputText;
const { startVideoJobPolling } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(fetchJob) {
  const timers = new Map(); let next = 0, details = [], done = 0;
  const stop = startVideoJobPolling(fetchJob, d => details.push(d), () => done++, {
    schedule: (fn, delay) => { assert.equal(delay,1500); timers.set(++next,fn); return next; },
    clear: id => timers.delete(id),
  });
  return {stop, timers, details, get done() {return done;}, async tick() {
    const entry = timers.entries().next().value; if(entry) {timers.delete(entry[0]); await entry[1]();}
  }};
}
for (const status of ['done','completed','failed','error','cancelled']) test(`stops immediately on ${status}`, async () => {
  let calls = 0; const f = fixture(async () => {calls++;return {job:{status}};});
  await flush(); assert.equal(calls,1); assert.equal(f.done,1); assert.equal(f.timers.size,0);
});
test('starts immediately, single timer, stops after active becomes terminal', async () => {
  let calls = 0; const f = fixture(async () => ({job:{status: ++calls === 3 ? 'done' : 'downloading'}}));
  await flush(); assert.equal(calls,1); assert.equal(f.timers.size,1);
  await f.tick(); assert.equal(f.timers.size,1); await f.tick(); assert.equal(f.timers.size,0); assert.equal(f.done,1);
});
test('slow request never overlaps; cleanup ignores late response', async () => {
  let resolve; const f=fixture(() => new Promise(r => resolve=r));
  assert.equal(f.timers.size,0); f.stop(); resolve({job:{status:'done'}}); await flush();
  assert.equal(f.details.length,0); assert.equal(f.done,0); assert.equal(f.timers.size,0);
});
test('cleanup clears timer and new job gets its own poller', async () => {
  const a=fixture(async () => ({job:{status:'pending'}})); await flush(); a.stop();
  assert.equal(a.timers.size,0);
  const b=fixture(async () => ({job:{status:'pending'}})); await flush(); assert.equal(b.timers.size,1); b.stop();
});
test('transient network error retries at normal cadence', async () => {
  let calls=0;const f=fixture(async () => {if (++calls===1) throw Error('network');return {job:{status:'error'}};});
  await flush();assert.equal(f.timers.size,1);await f.tick();assert.equal(f.done,1);assert.equal(f.timers.size,0);
});
test('rejected terminal callback is handled without restarting polling', async () => {
  let calls = 0, callbacks = 0, timers = 0;
  const stop = startVideoJobPolling(
    async () => { calls++; return { job: { status: 'error' } }; },
    () => {},
    async () => { callbacks++; throw Error('refresh failed'); },
    { schedule: () => { timers++; return 1; }, clear: () => {} },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(callbacks, 1); assert.equal(timers, 0);
  stop();
});
