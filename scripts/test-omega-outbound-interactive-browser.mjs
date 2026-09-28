import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// OMEGA V2 Phase 4 controller UI harness. The local API is fully mocked with
// page.route: no Cortex server, no host, no real SendInput is ever reached.
const sessionId = '11111111-1111-4111-8111-111111111111';
const XSS_DEVICE = '<img src=x onerror="window.__xssFired=true">';
const XSS_ERROR = '<img src=x onerror="window.__xssFired=true">';
let browser;
let server;
let assertions = 0;
let interactive = false;
let view = false;
let stoppedSession = false;
let permission = 'INTERACTIVE';
let inputMode = 'ok';
let frameMode = 'ok';
let startError = null;
let networkDown = false;
let frameKind = 'wide';
const frames = {};
const inputs = [];
const attempts = [];
const requests = [];
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const near = (value, expected, tolerance = 0.02) => Math.abs(value - expected) <= tolerance;
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/omega-outbound-view-harness.jsx");mount();</script>';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

try {
  server = await createServer({ configFile: false, cacheDir: '.tmp/vite-omega-interactive', plugins: [react()],
    optimizeDeps: { entries: ['scripts/omega-outbound-view-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5222, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() ?? '' }));
  await page.addInitScript(() => {
    window.__xssFired = undefined;
    window.__clipboardCalls = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { window.__clipboardCalls += 1; return ''; },
      writeText: async () => { window.__clipboardCalls += 1; },
      read: async () => { window.__clipboardCalls += 1; return []; },
      write: async () => { window.__clipboardCalls += 1; },
    } });
  });
  await page.route('**:3001/api/omega/outbound/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (networkDown) return route.abort('connectionrefused');
    if (path.endsWith('/sessions') && request.method() === 'GET') {
      const sessions = stoppedSession ? [] : [{ sessionId, remoteOmegaDeviceId: XSS_DEVICE, permission,
        status: 'CONNECTED', expiresAt: new Date(Date.now() + 60_000).toISOString() }];
      return json(route, 200, { sessions });
    }
    if (path.endsWith('/view/start')) { view = true; return json(route, 201, { view: { status: 'VIEW_STARTING', streamId: 'stream-1' } }); }
    if (path.endsWith('/view/frame')) {
      if (frameMode !== 'ok') { view = false; interactive = false; return json(route, 409, { error: frameMode }); }
      if (!view) return json(route, 409, { error: 'REMOTE_STOPPED' });
      return route.fulfill({ status: 200, contentType: 'image/png', body: frames[frameKind] });
    }
    if (path.endsWith('/interactive/start')) {
      if (permission === 'VIEW') return json(route, 403, { error: 'PERMISSION_DENIED' });
      if (startError) return json(route, 409, { error: startError });
      interactive = true; return json(route, 201, { interactive: { status: 'INTERACTIVE' } });
    }
    const inputMatch = path.match(/\/input\/(pointer|button|wheel|key)$/);
    if (inputMatch) {
      const body = request.postDataJSON();
      attempts.push({ category: inputMatch[1], body });
      if (inputMode !== 'ok') { interactive = false; return json(route, 409, { error: inputMode }); }
      if (!interactive || permission === 'VIEW') return json(route, 403, { error: 'PERMISSION_DENIED' });
      inputs.push({ category: inputMatch[1], body });
      return json(route, 200, { input: { accepted: true } });
    }
    if (path.endsWith('/interactive/stop')) { interactive = false; return json(route, 200, { interactive: { status: 'STOPPED' } }); }
    if (path.endsWith('/view/stop')) { interactive = false; view = false; return json(route, 200, { view: { status: 'STOPPED' } }); }
    if (path.endsWith('/stop')) { interactive = false; view = false; stoppedSession = true; return json(route, 200, { stopped: true }); }
    return json(route, 404, { error: 'route_not_found' });
  });
  await page.route('**/__omega_interactive_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto('http://127.0.0.1:5222/__omega_interactive_test');
  await page.getByRole('heading', { name: 'OMEGA VIEW ONLY' }).waitFor();

  // Non-square PNG frames generated by the browser itself (4:1 wide and 1:4 tall).
  for (const [name, width, height] of [['wide', 400, 100], ['tall', 100, 400]]) {
    const base64 = await page.evaluate(([w, h]) => {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const context = canvas.getContext('2d'); context.fillStyle = '#224466'; context.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    }, [width, height]);
    frames[name] = Buffer.from(base64, 'base64');
  }

  const viewport = page.getByLabel('Read-only remote viewport');
  const image = page.getByRole('img', { name: 'Remote screen' });
  const settle = (ms = 150) => page.waitForTimeout(ms);
  // Positive checks wait for the expected requests instead of a fixed delay (robust under CPU load).
  const until = async (predicate, ms = 3_000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await page.waitForTimeout(25);
    await settle(60);
  };
  const moveTo = async (x, y) => {
    const count = inputs.length;
    await viewport.dispatchEvent('pointermove', { clientX: x, clientY: y });
    await until(() => inputs.length > count);
    // Fail loudly and specifically here rather than letting the caller crash on
    // inputs.at(-1) === undefined: under heavy concurrent CPU load the 3 s wait
    // above can still be exceeded (app has its own 50 ms move debounce plus a
    // real network round-trip to the mocked route). This is a known environmental
    // timing flake, not a logic bug — see the Phase 6 report's flake measurement.
    if (inputs.length <= count) throw new Error(`moveTo(${x}, ${y}) timed out waiting for a pointer input (environmental/timing, not a product defect)`);
  };
  const interactiveLabel = state => page.getByText(`INTERACTIVE: ${state}`, { exact: true });
  const viewLabel = state => page.getByText(`VIEW: ${state}`, { exact: true });
  const imageBox = async () => image.boundingBox({ timeout: 1_000 });
  const pointerAt = async (x, y) => { await viewport.dispatchEvent('pointermove', { clientX: x, clientY: y }); await settle(120); };
  const click = async (button, x, y) => {
    await viewport.dispatchEvent('pointerdown', { button, clientX: x, clientY: y, pointerId: 1 });
    await viewport.dispatchEvent('pointerup', { button, clientX: x, clientY: y, pointerId: 1 });
  };
  const hammer = async () => {
    const box = await imageBox().catch(() => null) ?? { x: 300, y: 300, width: 10, height: 10 };
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    await viewport.focus().catch(() => {});
    await pointerAt(cx, cy);
    await click(0, cx, cy); await click(1, cx, cy); await click(2, cx, cy);
    await viewport.dispatchEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy });
    await page.keyboard.press('KeyK'); await page.keyboard.press('Enter');
    await settle(150);
  };
  const waitFrame = async kind => {
    frameKind = kind;
    const expected = kind === 'wide' ? 400 : 100;
    await page.waitForFunction(width => document.querySelector('img[alt="Remote screen"]')?.naturalWidth === width, expected, { timeout: 5_000 });
  };
  const startView = async () => {
    await page.getByRole('button', { name: 'Start VIEW' }).click();
    await viewLabel('VIEWING').waitFor();
    await image.waitFor();
  };
  const startInteractive = async () => {
    await page.getByRole('button', { name: 'Start INTERACTIVE' }).click();
    await interactiveLabel('INTERACTIVE').waitFor();
  };

  // 1. Input OFF by default: no click, key or move leaves the browser.
  check(await interactiveLabel('STOPPED').isVisible(), 'INTERACTIVE is initially off');
  await viewport.click(); await viewport.press('KeyA'); await viewport.dispatchEvent('pointermove', { clientX: 10, clientY: 10 });
  await settle();
  check(attempts.length === 0, 'input off forwards no event before VIEW');

  // 2. VIEW alone is read-only: still no input until the explicit START.
  await startView();
  await page.addStyleTag({ content: 'img[alt="Remote screen"]{width:400px!important;height:200px!important;max-width:none!important;max-height:none!important}' });
  await waitFrame('wide');
  await hammer();
  check(attempts.length === 0, 'VIEWING without START INTERACTIVE forwards 0 click/key/wheel/move');
  check(await page.getByRole('button', { name: 'Start INTERACTIVE' }).isEnabled(), 'explicit START available only over VIEWING');

  // 3. Explicit START, visible INTERACTIVE label.
  await startInteractive();
  check(interactive, 'explicit INTERACTIVE start reached backend');
  check(await interactiveLabel('INTERACTIVE').isVisible(), 'INTERACTIVE label visible');

  // 4. Pointer mapping: 4:1 frame in a 400x200 box has 50px bands top and bottom.
  let box = await imageBox();
  let before = attempts.length;
  await pointerAt(box.x + 200, box.y + 20);
  check(attempts.length === before, 'pointer over the top letterbox band is not forwarded');
  await moveTo(box.x + 100, box.y + 50 + 75);
  let last = inputs.at(-1);
  check(last.category === 'pointer' && near(last.body.x, 0.25) && near(last.body.y, 0.75), `horizontal-band letterbox mapping (${JSON.stringify(last.body)})`);
  await moveTo(box.x + 0.5, box.y + 50.5);
  last = inputs.at(-1);
  check(last.body.x >= 0 && last.body.y >= 0 && near(last.body.x, 0, 0.01) && near(last.body.y, 0, 0.01), 'top-left of the displayed frame maps to 0,0');
  await moveTo(box.x + 399.5, box.y + 149.5);
  last = inputs.at(-1);
  check(last.body.x < 1 && last.body.y < 1 && near(last.body.x, 1, 0.01) && near(last.body.y, 1, 0.01), 'bottom-right maps to max-1 (strictly < 1)');

  // 1:4 frame in the same box: content is 50x200 centred, bands left and right.
  await waitFrame('tall');
  box = await imageBox();
  before = attempts.length;
  await pointerAt(box.x + 60, box.y + 100);
  check(attempts.length === before, 'pointer over the left letterbox band is not forwarded');
  await moveTo(box.x + 175 + 12.5, box.y + 150);
  last = inputs.at(-1);
  check(near(last.body.x, 0.25) && near(last.body.y, 0.75), `vertical-band letterbox mapping (${JSON.stringify(last.body)})`);

  // Scaled viewport: a 2x larger box keeps the same normalized point.
  await page.addStyleTag({ content: 'img[alt="Remote screen"]{width:800px!important;height:400px!important}' });
  await waitFrame('wide');
  box = await imageBox();
  check(Math.round(box.width) === 800, 'viewport rescaled');
  await moveTo(box.x + 200, box.y + 100 + 150);
  last = inputs.at(-1);
  check(near(last.body.x, 0.25) && near(last.body.y, 0.75), `scaled viewport mapping (${JSON.stringify(last.body)})`);
  await page.addStyleTag({ content: 'img[alt="Remote screen"]{width:400px!important;height:200px!important}' });
  box = await imageBox();
  const cx = box.x + 200; const cy = box.y + 100;

  // 5. Buttons, wheel, keyboard.
  before = inputs.length;
  await click(0, cx, cy); await click(2, cx, cy); await click(1, cx, cy);
  await until(() => inputs.length >= before + 6);
  const buttons = inputs.slice(before).filter(value => value.category === 'button').map(value => `${value.body.button}:${value.body.state}`);
  check(JSON.stringify(buttons) === JSON.stringify(['LEFT:DOWN', 'LEFT:UP', 'RIGHT:DOWN', 'RIGHT:UP', 'MIDDLE:DOWN', 'MIDDLE:UP']), `left/right/middle click DOWN/UP (${buttons})`);
  check(inputs.slice(before).every(value => value.category !== 'button' || (near(value.body.x, 0.5) && near(value.body.y, 0.5))), 'button coordinates mapped');
  before = inputs.length;
  await viewport.dispatchEvent('wheel', { deltaY: 120, clientX: cx, clientY: cy });
  await viewport.dispatchEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy });
  await until(() => inputs.length >= before + 2);
  const wheels = inputs.slice(before).filter(value => value.category === 'wheel').map(value => value.body.delta);
  check(JSON.stringify(wheels) === '[-1,1]', `wheel mapped and bounded to +/-1 (${wheels})`);
  before = attempts.length;
  await viewport.dispatchEvent('wheel', { deltaY: 120, clientX: box.x + 5, clientY: box.y + 5 });
  await settle();
  check(attempts.length === before, 'wheel over letterbox is not forwarded');

  await viewport.focus();
  before = inputs.length;
  await page.keyboard.press('KeyA');
  await until(() => inputs.length >= before + 2);
  const keys = inputs.slice(before).map(value => `${value.body.key}:${value.body.state}`);
  check(JSON.stringify(keys) === '["KeyA:DOWN","KeyA:UP"]', `allowlisted key forwarded only while focused (${keys})`);
  await page.getByLabel('Screen index').focus();
  before = attempts.length;
  await page.keyboard.press('KeyB'); await page.keyboard.press('Enter');
  await settle();
  check(attempts.length === before, 'keyboard is not captured when the viewport does not have focus');
  await viewport.focus();
  before = attempts.length;
  await page.keyboard.press('PrintScreen'); await page.keyboard.press('NumpadEnter'); await page.keyboard.press('MediaPlayPause');
  await settle();
  check(attempts.length === before, 'non-allowlisted keys are not forwarded');

  // Stuck-input guards: blur releases a held key, an UP outside the frame is clamped.
  before = inputs.length;
  await page.keyboard.down('ShiftLeft');
  await settle(80);
  await page.getByLabel('Screen index').focus();
  await until(() => inputs.length >= before + 2);
  await page.keyboard.up('ShiftLeft');
  const blur = inputs.slice(before).map(value => `${value.body.key}:${value.body.state}`);
  check(JSON.stringify(blur) === '["ShiftLeft:DOWN","ShiftLeft:UP"]', `focus loss releases held keys (${blur})`);
  before = inputs.length;
  await viewport.dispatchEvent('pointerdown', { button: 0, clientX: cx, clientY: cy, pointerId: 1 });
  await viewport.dispatchEvent('pointerup', { button: 0, clientX: box.x + 900, clientY: box.y - 300, pointerId: 1 });
  await until(() => inputs.length >= before + 2);
  const drag = inputs.slice(before).filter(value => value.category === 'button');
  check(drag.length === 2 && drag[1].body.state === 'UP' && drag[1].body.x < 1 && drag[1].body.y >= 0, 'UP released outside the frame is still sent, clamped in bounds');

  // No file transfer, no clipboard sync.
  before = attempts.length;
  const requestsBefore = requests.length;
  await page.evaluate(() => {
    const target = document.querySelector('[aria-label="Read-only remote viewport"]');
    const data = new DataTransfer();
    data.items.add(new File(['TOP-SECRET-FILE-CONTENT'], 'secret.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    const clip = new DataTransfer(); clip.setData('text/plain', 'SECRET-CLIPBOARD-TEXT');
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clip, bubbles: true, cancelable: true }));
    target.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
  });
  await settle();
  check(attempts.length === before, 'drag/drop and paste forward 0 input');
  check(!requests.slice(requestsBefore).some(value => /TOP-SECRET|SECRET-CLIPBOARD|multipart/i.test(value.body + value.url)), 'file drop -> 0 transfer, paste -> 0 clipboard sync');
  check(await page.locator('input[type=file]').count() === 0, 'no file input exists');
  check(await page.evaluate(() => window.__clipboardCalls) === 0, 'clipboard API never used');
  check(await page.evaluate(() => window.__xssFired === undefined), 'device name remains XSS inert');
  check(await page.getByText(XSS_DEVICE, { exact: false }).count() >= 1, 'device name rendered as literal text');

  // 6. Escape stays local, stops INTERACTIVE and returns to VIEW.
  await viewport.focus();
  before = attempts.length;
  await page.keyboard.press('Escape');
  await interactiveLabel('STOPPED').waitFor();
  check(!interactive, 'Escape performs the local INTERACTIVE stop');
  check(attempts.length === before && !attempts.some(value => value.body?.key === 'Escape'), 'Escape is never transmitted');
  check(await viewLabel('VIEWING').isVisible(), 'STOP INTERACTIVE (Escape) returns to VIEW');
  await hammer();
  check(attempts.length === before, '0 remote input after STOP INTERACTIVE');

  // 7. STOP INTERACTIVE button returns to VIEW.
  await startInteractive();
  await page.getByRole('button', { name: 'Stop INTERACTIVE' }).click();
  await interactiveLabel('STOPPED').waitFor();
  check(await viewLabel('VIEWING').isVisible() && !interactive, 'STOP INTERACTIVE button returns to VIEW');

  // 8. STOP VIEW kills INTERACTIVE.
  await startInteractive();
  await page.getByRole('button', { name: 'Stop VIEW' }).click();
  await viewLabel('STOPPED').waitFor();
  check(await interactiveLabel('STOPPED').isVisible() && !interactive, 'STOP VIEW kills INTERACTIVE');
  before = attempts.length; await hammer();
  check(attempts.length === before, '0 remote input after STOP VIEW');

  // 9. Host rejections (expired, revoked, wrong stream) stop INTERACTIVE locally.
  for (const code of ['SESSION_EXPIRED', 'DEVICE_REVOKED', 'WRONG_STREAM']) {
    inputMode = 'ok';
    if (!(await viewLabel('VIEWING').isVisible())) await startView();
    await startInteractive();
    inputMode = code;
    await viewport.focus(); await page.keyboard.press('KeyA');
    await interactiveLabel('STOPPED').waitFor();
    await settle();
    check((await page.getByRole('alert').textContent()) === code, `${code} rejected input surfaces the error`);
    inputMode = 'ok';
    before = attempts.length; await hammer();
    check(attempts.length === before, `0 remote input after ${code}`);
  }

  // 10. Remote STOP (host indicator / host ended the session) kills VIEW and INTERACTIVE.
  if (!(await viewLabel('VIEWING').isVisible())) await startView();
  await startInteractive();
  frameMode = 'REMOTE_STOPPED';
  await viewLabel('STOPPED').waitFor();
  check(await interactiveLabel('STOPPED').isVisible(), 'remote STOP kills INTERACTIVE and VIEW');
  before = attempts.length; await hammer();
  check(attempts.length === before, '0 remote input after remote STOP');
  frameMode = 'ok';

  // 11. Network drop kills everything, no auto-reconnect.
  await startView(); await startInteractive();
  networkDown = true;
  await viewLabel('STOPPED').waitFor({ timeout: 5_000 });
  check(await interactiveLabel('STOPPED').isVisible(), 'network drop kills INTERACTIVE and VIEW');
  check((await page.getByRole('alert').textContent()) === 'NETWORK_UNAVAILABLE', 'network drop reported');
  before = attempts.length;
  const requestsAtDrop = requests.length;
  await hammer(); await settle(1_500);
  check(attempts.length === before, '0 remote input after disconnect');
  check(!requests.slice(requestsAtDrop).some(value => /\/view\/(start|frame)|\/interactive\/start|\/connect/.test(value.url)), 'no automatic reconnect or restart');
  networkDown = false;

  // 12. XSS-safe remote error.
  await startView();
  startError = XSS_ERROR;
  await page.getByRole('button', { name: 'Start INTERACTIVE' }).click();
  await page.getByRole('alert').waitFor();
  check((await page.getByRole('alert').textContent()) === XSS_ERROR, 'remote error rendered as literal text');
  check(await page.evaluate(() => window.__xssFired === undefined && !document.querySelector('[role=alert] img')), 'remote error remains XSS inert');
  startError = null;

  // 13. VIEW-only permission cannot activate input, even with a direct call.
  await page.getByRole('button', { name: 'Stop VIEW' }).click();
  await viewLabel('STOPPED').waitFor();
  permission = 'VIEW';
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await startView();
  check(await page.getByRole('button', { name: 'Start INTERACTIVE' }).isDisabled(), 'VIEW permission cannot activate input');
  before = attempts.length; await hammer();
  check(attempts.length === before, 'VIEW-only session sends 0 input from the UI');
  const denied = await page.evaluate(async id => (await fetch(`http://127.0.0.1:3001/api/omega/outbound/sessions/${id}/input/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'KeyA', state: 'DOWN' }),
  })).status, sessionId);
  check(denied === 403, 'VIEW direct input attempt rejected');

  // 14. STOP SESSION kills VIEW and INTERACTIVE.
  permission = 'INTERACTIVE';
  await page.getByRole('button', { name: 'Refresh sessions' }).click();
  await startInteractive();
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.getByText(/CONNECTION: DISCONNECTED/).waitFor();
  check(!interactive && !view, 'STOP SESSION kills VIEW and INTERACTIVE');
  check(await interactiveLabel('STOPPED').isVisible() && await viewLabel('STOPPED').isVisible(), 'UI shows everything stopped');
  before = attempts.length; await hammer();
  check(attempts.length === before, '0 remote input after STOP SESSION');

  // 15. Everything stayed on loopback: no cloud, no third-party endpoint.
  check(requests.every(value => /^(http:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(value.url)), 'all requests stay on loopback');
  check(!attempts.some(value => /text|command|exec|clip/i.test(JSON.stringify(value.body))), 'no text/command/clipboard payload ever sent');
  console.log(`OMEGA INTERACTIVE BROWSER PASS ${assertions}/${assertions}`);
} finally {
  await browser?.close();
  await server?.close();
}
