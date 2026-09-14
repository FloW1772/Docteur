import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.route('**/__video_test', route => route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'}));
  await page.goto('http://127.0.0.1:5183/__video_test');
  await page.evaluate(async () => { const {mount} = await import('/scripts/video-browser-harness.jsx'); mount(); });
  await page.waitForFunction(()=>window.done===1, null, {timeout:10000}).catch(async err => {
    console.log({errors, state:await page.evaluate(()=>({calls:window.calls,done:window.done,text:document.body.innerText.slice(0,500)}))});throw err;
  });
  const calls=await page.evaluate(()=>window.calls);
  await page.waitForTimeout(3300);
  assert.equal(await page.evaluate(()=>window.calls),calls,'parent rerender must not restart terminal polling');
  await page.evaluate(()=>window.root.unmount());
  assert.deepEqual(errors,[]);
  console.log('Browser React StrictMode: terminal error, parent rerender, unmount; no page errors. PASS');
} finally {await browser.close();}
