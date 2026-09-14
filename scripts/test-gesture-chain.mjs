import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const logs = [];
  page.on('console', m => logs.push(m.text()));
  await page.addInitScript(() => {
    localStorage.setItem('docteur-gesture-debug', 'true');
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { get: () => 4 });
    HTMLVideoElement.prototype.play = async () => {};
    window.pose = null;
  });
  await page.route(/.*tasks-vision.*\.m?js.*/, route => route.fulfill({ contentType: 'text/javascript', body: 'export const FilesetResolver={forVisionTasks:async()=>({})};export const HandLandmarker={createFromOptions:async()=>({close(){},detectForVideo(){return {landmarks:window.pose?[window.pose]:[],handednesses:[[{score:0.99}]]}}})};' }));
  await page.route('**/__gesture_test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/gesture-regression-harness.jsx").then(m=>m.mount());</script>' }));
  await page.goto('http://127.0.0.1:5173/__gesture_test');
  await page.waitForFunction(() => window.gestureTest);
  await page.evaluate(() => window.gestureTest.toggle());
  await page.waitForFunction(() => window.gestureTest.gestureState === 'active');
  async function pose(count, x = 0, y = 0) {
    await page.evaluate(({ count, x, y }) => {
      if (count === null) { window.pose = null; return; }
      const lm = Array.from({ length: 21 }, () => ({ x: 0.5 + x, y: 0.7 + y, z: 0 }));
      for (const [i, base] of [5, 9, 13, 17].entries()) {
        lm[base] = { x: 0.45 + i * 0.03 + x, y: 0.5 + y, z: 0 };
        lm[base + 1] = { ...lm[base], y: 0.4 + y };
        lm[base + 3] = { ...lm[base], y: (i < count || count === 5 ? 0.3 : 0.55) + y };
      }
      lm[4] = { ...lm[5], x: lm[5].x - (count === 5 ? 0.2 : 0.01) };
      window.pose = lm;
    }, { count, x, y });
  }
  const wait = () => page.waitForTimeout(350);
  await pose(0); await wait(); await pose(1); await wait(); await pose(1, 0.15); await wait();
  assert.equal(await page.evaluate(() => window.actions.filter(x => x === 'next').length), 1);
  await pose(1, 0.3); await wait(); await pose(1, 0.45); await wait();
  assert.equal(await page.evaluate(() => window.actions.filter(x => x === 'next').length), 1);
  await pose(0); await wait(); await pose(1); await wait(); await pose(1, 0.15); await wait();
  assert.equal(await page.evaluate(() => window.actions.filter(x => x === 'next').length), 2);
  await pose(null); await wait();
  assert.equal(await page.evaluate(() => window.gestureTest.debugInfo.confirmedCount), null);
  await pose(3); await wait(); await pose(3, 0, 0.15); await wait(); await pose(3, 0, 0.3); await wait();
  assert.equal(await page.evaluate(() => window.actions.filter(x => x === 'scroll').length), 1);
  await pose(5); await wait();
  for (let i = 1; i <= 10; i++) { await pose(5, i * 0.004); await page.waitForTimeout(90); }
  assert.ok(await page.evaluate(() => window.actions.includes('rotate')));
  assert.ok(logs.some(x => x.includes('applyGestureInput')));
  for (const state of ['DETECTION_OK', 'GESTURE_ACCEPTED', 'GESTURE_BLOCKED']) assert.ok(logs.some(x => x.includes(state)), state);
  console.log('PASS real hook + synthetic landmarks: 0→1 swipe, held gesture once, 1→0→1 rearmed, hand absent neutral, 3-finger scroll once, slow 5-finger motion reaches OrbitalBrain');
} finally { await browser.close(); }
