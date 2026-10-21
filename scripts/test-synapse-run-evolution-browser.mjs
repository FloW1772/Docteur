// GAME-7 real Chromium: real host fullscreen, projected direction and retained sandbox boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { arcadeGameBundlePlugin } from './vite-arcade-game-bundle.mjs';

const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/arcade-save-harness.jsx");mount();</script>';
let server, browser, assertions = 0;
const eq = (a,b,label) => {assert.deepEqual(a,b,label);assertions++;};
const ok = (v,label) => {assert.ok(v,label);assertions++;};
const errors = [], external = [], screenshots = [];
const hook = (f,name,...args) => f.evaluate(([n,a]) => window.__synapseRunTest[n](...a), [name,args]);
const snapshot = f => hook(f,'snapshot');
fs.mkdirSync('.tmp/game7', {recursive:true});
try {
  server = await createServer({configFile:false,plugins:[react(),arcadeGameBundlePlugin({testHooks:true})],cacheDir:'.tmp/vite-game7',optimizeDeps:{entries:['scripts/arcade-save-harness.jsx']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},logLevel:'error'});
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless:process.env.GAME7_HEADED !== '1',args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11',...(process.env.GAME7_HEADED === '1' ? ['--window-position=-32000,-32000'] : [])]});
  const context = await browser.newContext({viewport:{width:1280,height:900},hasTouch:true});
  await context.addInitScript(() => {
    const listeners = new Set(), add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    window.__g7FullscreenListeners = listeners;
    document.addEventListener = (type, listener, options) => { if (type === 'fullscreenchange') listeners.add(listener); return add(type, listener, options); };
    document.removeEventListener = (type, listener, options) => { if (type === 'fullscreenchange') listeners.delete(listener); return remove(type, listener, options); };
  });
  const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=> {
    const u=new URL(route.request().url());
    if(u.pathname==='/__game7') return route.fulfill({contentType:'text/html',body:html});
    if(u.origin!==origin || u.pathname.startsWith('/api/')) {external.push(u.href);return route.abort();}
    return route.continue();
  });
  const launch = async () => {
    await page.getByTestId('arcade-launch-synapse-run').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="arcade-host"]')?.dataset.phase==='active');
    const f=page.frames().find(f=>f.url().includes('/arcade/synapse-run/'));
    await f.waitForFunction(()=>window.__synapseRunTest?.snapshot().host==='active');
    await hook(f,'setManual',true); await hook(f,'restart',20261021);
    await f.locator('#sr-action').click(); await hook(f,'advance',1); return f;
  };
  await page.goto(`${origin}/__game7`); let f=await launch();
  eq(await page.getByTestId('arcade-frame').getAttribute('sandbox'),'allow-scripts');
  ok((await page.getByTestId('arcade-frame').getAttribute('allow')).includes("fullscreen 'none'"));
  for(const mode of ['keyboard','letter','touch','swipe']) {
    await hook(f,'restart',20261021); await f.locator('#sr-action').click(); await hook(f,'advance',1);
    for(const direction of ['left','right','right','left']) {
      const before=await snapshot(f), sign=direction==='left'?-1:1;
      if(mode==='keyboard' || mode==='letter') {await f.locator('#sr-viewport').focus();await page.keyboard.press(mode==='keyboard'?(sign<0?'ArrowLeft':'ArrowRight'):(sign<0?'a':'d'));}
      if(mode==='touch') await f.locator(`[data-control="${direction}"]`).tap();
      if(mode==='swipe') {
        await f.locator('#sr-viewport').dispatchEvent('pointerdown',{pointerId:1,isPrimary:true,clientX:180,clientY:180,pointerType:'touch'});
        await f.locator('#sr-viewport').dispatchEvent('pointerup',{pointerId:1,isPrimary:true,clientX:180+sign*80,clientY:180,pointerType:'touch'});
      }
      await hook(f,'advance',8); const after=await snapshot(f);
      eq(after.lane,before.lane+sign,mode);
      eq(Math.sign(after.view.player.x-before.view.player.x),sign,'world X');
      eq(Math.sign(after.view.player.screenX-before.view.player.screenX),sign,'screen projection');
    }
  }
  console.log('PASS keyboard / A D / real touch / swipes: actual screen direction');
  const full=page.getByTestId('arcade-fullscreen');
  const embedded=(await snapshot(f)).view;
  const tick=(await snapshot(f)).tick;
  await full.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.waitForFunction(()=>document.querySelector('[data-testid="arcade-fullscreen"]').getAttribute('aria-pressed')==='true');
  await f.waitForFunction(()=>{const v=window.__synapseRunTest.snapshot().view;return v.width===innerWidth && v.height===innerHeight;});
  const enlarged=(await snapshot(f)).view;
  ok(enlarged.height>embedded.height,'fullscreen expands the actual render buffer');
  eq(enlarged.aspect,enlarged.width/enlarged.height,'fullscreen perspective aspect');
  await page.getByTestId('arcade-host').screenshot({path:'.tmp/game7/fullscreen.png'});
  eq((await snapshot(f)).tick,tick,'fullscreen keeps state');
  await page.getByTestId('arcade-pause-toggle').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="arcade-host"]').dataset.phase==='paused');
  await hook(f,'advance',60); eq((await snapshot(f)).tick,tick);
  await full.click(); await page.waitForFunction(()=>!document.fullscreenElement);
  eq((await snapshot(f)).tick,tick);
  await page.getByTestId('arcade-pause-toggle').click();
  await full.click(); await page.waitForFunction(()=>!!document.fullscreenElement);
  await full.focus();
  // Host-focused Escape; no preventDefault or keyboard lock replaces the browser behavior.
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  const nativeEscapeExited=await page.evaluate(()=>!document.fullscreenElement);
  eq(nativeEscapeExited,true,'real Escape exits without closing the Studio');
  await page.waitForFunction(()=>!document.fullscreenElement);
  const escapeExited=true;
  await page.waitForFunction(()=>document.querySelector('[data-testid="arcade-fullscreen"]').getAttribute('aria-pressed')==='false');
  eq(await full.evaluate(el=>el===document.activeElement),true,'focus restored on external exit');
  await full.click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await f.waitForFunction(()=>document.documentElement.dataset.hostFullscreen==='true');
  await f.locator('#sr-viewport').focus();
  const pauseBefore=(await snapshot(f)).pause;
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);
  eq((await snapshot(f)).pause,pauseBefore,'iframe Escape exits without toggling pause');
  // A stale instance cannot even exit the current host fullscreen.
  await full.click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await f.evaluate(()=>parent.postMessage({channel:'docteur-arcade',v:1,type:'ARCADE_FULLSCREEN_EXIT',gameId:'synapse-run',instanceId:'0'.repeat(32),payload:{}},location.origin));
  await page.waitForTimeout(60);eq(await page.evaluate(()=>!!document.fullscreenElement),true);
  await full.click();await page.waitForFunction(()=>!document.fullscreenElement);
  await full.click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.evaluate(()=>document.exitFullscreen());
  await page.waitForFunction(()=>document.querySelector('[data-testid="arcade-fullscreen"]').getAttribute('aria-pressed')==='false');
  console.log(`PASS fullscreen enter/exit, pause, external state; host Escape=${escapeExited}`);
  await page.setViewportSize({width:360,height:780});
  await page.waitForTimeout(250);
  let s=await snapshot(f);
  ok(s.view.width<=360 && s.view.width>100); eq(s.tick,tick,'resize does not tick');
  eq(s.view.aspect,s.view.width/s.view.height,'narrow perspective aspect');
  await page.getByTestId('arcade-host').screenshot({path:'.tmp/game7/narrow.png'});
  ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'360px no horizontal overflow');
  await page.setViewportSize({width:1280,height:900});
  await hook(f,'setAutopilot',20261021);
  await hook(f,'restart',20261021);
  const zones=[];
  for(const threshold of [0,500,1200,2200,3500]) {
    while((await snapshot(f)).distance<threshold+110) await hook(f,'advance',300);
    s=await snapshot(f); eq(s.status,'RUNNING'); zones.push({zone:s.zone,name:s.view.zone,distance:s.distance,calls:s.view.calls,geometries:s.view.geometries,programs:s.view.programs});
    const path=`.tmp/game7/zone-${s.zone}.png`;await f.locator('.sr-app').screenshot({path}); screenshots.push(path);
    ok(s.view.calls<=100,'draw call budget');
  }
  eq(zones.map(z=>z.zone),[0,1,2,3,4]);
  const boundary=await f.evaluate(async()=>{
    const blocked=fn=>{try{fn();return false;}catch{return true;}};
    return {origin:self.origin,parentDOM:blocked(()=>parent.document.body),parentStorage:blocked(()=>parent.localStorage.length),indexedDB:blocked(()=>indexedDB.open('game7-probe')),directAPI:await fetch('/api/health').then(()=>false,()=>true),fullscreen:document.fullscreenEnabled};
  });
  eq(boundary,{origin:'null',parentDOM:true,parentStorage:true,indexedDB:true,directAPI:true,fullscreen:false});
  // Repeated enter / stop / relaunch: old section and fullscreen listeners are removed each time.
  for(let i=0;i<5;i++) {
    await full.click();await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.getByTestId('arcade-stop').click();await page.waitForFunction(()=>!document.fullscreenElement);
    eq(await page.evaluate(()=>window.__g7FullscreenListeners.size),0,'fullscreen listener removed');
    f=await launch();eq((await snapshot(f)).listeners,11);eq((await snapshot(f)).canvas,1);
    eq(await page.evaluate(()=>window.__g7FullscreenListeners.size),1,'one fullscreen listener per launch');
  }
  await page.getByTestId('arcade-stop').click();
  await page.evaluate(()=>{ window.__originalFullscreen = Element.prototype.requestFullscreen; Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('denied')); });
  f=await launch();await full.click();
  await page.getByText('Le navigateur a refusé le plein écran. Le jeu reste disponible.').waitFor();
  eq((await snapshot(f)).status,'RUNNING');eq(await page.evaluate(()=>document.fullscreenElement),null);
  await page.getByTestId('arcade-stop').click();
  await page.evaluate(()=>{Element.prototype.requestFullscreen=window.__originalFullscreen;delete window.__originalFullscreen;});
  await page.evaluate(()=>Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false}));
  f=await launch();eq(await full.isDisabled(),true);ok((await full.innerText()).includes('indisponible'));
  eq((await snapshot(f)).status,'RUNNING');
  eq(errors,[]);eq(external,[]);
  const result={assertions,zones,escapeExited,nativeEscapeExited,escapeEvidence:'Playwright keyboard Escape with host focus and iframe focus; no DOM-event fallback',boundary,errors,externalRequests:external.length,screenshots};
  fs.writeFileSync(process.env.GAME7_HEADED === '1' ? '.tmp/game7/browser-native.json' : '.tmp/game7/browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await server?.close();}
