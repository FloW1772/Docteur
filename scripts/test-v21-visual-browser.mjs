import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
let browser, server, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/v21-audit-harness.jsx");mount();</script>';
mkdirSync('.tmp/v21/qa', {recursive:true});
try {
 server = await createServer({configFile:false,plugins:[react()],optimizeDeps:{entries:['scripts/v21-audit-harness.jsx']},server:{watch:null,host:'127.0.0.1',port:5303,hmr:false},logLevel:'error'});
 await server.listen(); browser = await chromium.launch({headless:true});
 for (const [width,height] of [[1920,1080],[1440,900],[1366,768],[1024,768],[768,1024],[390,844]]) {
  const page = await browser.newPage({viewport:{width,height}});
  page.setDefaultTimeout(15000); console.log('QA viewport',width); const errors=[]; page.on('pageerror', e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/api/**',r=>r.abort());
  await page.route('**/__qa?*',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto('http://127.0.0.1:5303/__qa?layoutOnly',{waitUntil:'domcontentloaded',timeout:15000});
  await page.locator('.hud2-command-bar').waitFor().catch(async()=>{console.log('Retry after dependency warmup');await page.reload();await page.locator('.hud2-command-bar').waitFor();});
  await page.waitForTimeout(400);
  check(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),`overflow ${width}`);
  const selectors=width>=768?['.shell-sidebar','.shell-topbar','.hud2-corner--tl','.hud2-corner--tr','.hud2-corner--bl','.hud2-corner--br','.hud2-rail','.hud2-command-bar']:['.shell-topbar','.hud2-command-bar'];
  check(await page.locator('.topbar-right button').evaluateAll(els=>els.filter(el=>getComputedStyle(el).display!=='none').every(el=>{const r=el.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth;})), 'TopBar actions in viewport');
  const boxes=[];
  for (const selector of selectors) {
   const box=await page.locator(selector).boundingBox();
   check(box && box.x>=-1 && box.y>=-1 && box.x+box.width<=width+1 && box.y+box.height<=height+1,`${selector} outside ${width}: ${JSON.stringify(box)}`);
   boxes.push({selector,...box});
  }
  if(width>=768) for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
   const a=boxes[i],b=boxes[j];
   check(!(a.x<b.x+b.width-1 && a.x+a.width>b.x+1 && a.y<b.y+b.height-1 && a.y+a.height>b.y+1),`${width} overlap ${a.selector} ${b.selector}`);
  }
  const input=page.locator('.hud2-command-bar-input'); await input.focus(); await page.keyboard.type('QA');
  await page.keyboard.press('Tab'); check(await page.locator('.hud2-command-bar-send').evaluate(el=>el===document.activeElement),'send via Tab');
  await page.keyboard.press('Shift+Tab'); check(await input.evaluate(el=>el===document.activeElement),'input via Shift Tab');
  const more=page.locator('.topbar-more > button'); await more.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor(); await page.keyboard.press('Escape');
  check(await more.evaluate(el=>el===document.activeElement),'Escape restores focus');
  check(!(await page.getByRole('menu').isVisible()),'menu closed');
  check(await page.locator('.topbar-action:disabled').isVisible(),'Voice visible when disabled');
  await page.screenshot({path:`.tmp/v21/qa/dashboard-${width}.png`});
  if(width===1440) {
   for(const state of ['idle','listening','thinking','searching','generating','done','error']) {
    await page.getByTestId(`set-state-${state}`).click();
    check(await page.locator('.hud2-cortex-atmosphere').getAttribute('data-state')===state,`state ${state}`);
   }
   await page.locator('.topbar-search').click(); await page.getByRole('dialog',{name:'Search',exact:true}).waitFor(); checks++; await page.getByRole('button',{name:'Close',exact:true}).click();
   await page.emulateMedia({reducedMotion:'reduce'});
   check(await page.locator('.hud2-cortex-dust').evaluate(el=>getComputedStyle(el).display==='none'),'reduced particles');
   check(await page.locator('.hud2-cortex-orbit').evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration)<.001),'reduced transition');
   check(await page.locator('.hud2-cortex-link-dot').evaluateAll(els=>els.every(el=>getComputedStyle(el).animationName==='none')),'no link animation');
   await page.screenshot({path:'.tmp/v21/qa/reduced-motion.png'});
   await page.getByTestId('mode-toggle').click(); check(await page.locator('.hud2-corner').count()===0,'Focus hides widgets');
   await page.getByTestId('mode-toggle').click(); check(await page.locator('.hud2-corner').count()===4,'Dashboard restores widgets');
  }
  check(errors.length===0,errors.join('\n')); await page.close();
 }
 console.log(`V2.1 VISUAL QA PASS ${checks}/${checks}`);
} finally { await browser?.close(); await server?.close(); }

