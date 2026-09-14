import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
const baseline = execFileSync('git', ['-c', 'safe.directory=C:/dev/Docteur', 'show', 'HEAD:src/hooks/usePages.ts'], { encoding: 'utf8' });
writeFileSync('scripts/pages-before.ts', baseline.replaceAll("'../lib/", "'../src/lib/").replace("'./useConnectivity'", "'../src/hooks/useConnectivity'"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', async route => {
    const response = await route.fetch({ url: route.request().url().replace(/:\d+\/api\//, ':3002/api/') });
    await route.fulfill({ response });
  });
  await page.route('**/__before_test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import("/scripts/agent-before-harness.jsx").then(m=>m.mount());</script>' }));
  await page.goto('http://127.0.0.1:5173/__before_test');
  await page.waitForFunction(() => window.before && !window.before.loading);
  const id = await page.evaluate(async () => {
    const page = await window.before.createPage('rapport');
    window.before.updatePage(page.id, { title: 'Agent baseline', blocks: [{ id: 'before-block', type: 'paragraph', content: 'Agent output' }] });
    await window.before.flushAllSaves();
    return page.id;
  });
  await page.waitForTimeout(1200);
  const stored = (await (await fetch(`http://127.0.0.1:3002/api/neuron/${id}`)).json()).page;
  console.log('BEFORE agent flow', { storedBlockLengths: stored.blocks.map(b => b.content.length), uiBlockLengths: await page.evaluate(id => window.before.pages.find(p => p.id === id).blocks.map(b => b.content.length), id) });
} finally { await browser.close(); unlinkSync('scripts/pages-before.ts'); }
