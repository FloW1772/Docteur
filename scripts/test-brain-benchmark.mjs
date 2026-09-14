import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
const baseline = execFileSync('git', ['-c', 'safe.directory=C:/dev/Docteur', 'show', 'HEAD:src/components/neural/NeuralBrain.tsx'], { encoding: 'utf8' });
writeFileSync('scripts/brain-before.tsx', baseline.replace("'../../lib/types'", "'../src/lib/types'"));
const browser = await chromium.launch({ headless: true });
try {
  for (const before of [true, false]) {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { if (m.text().includes('brain.setPages')) logs.push(m.text()); });
    await page.route('**/__brain_test', route => route.fulfill({ contentType: 'text/html', body: `<div id="root" style="width:1200px;height:800px"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;import('/scripts/brain-benchmark.jsx').then(m=>m.mount(${before}));</script>` }));
    await page.goto('http://127.0.0.1:5173/__brain_test');
    await page.waitForTimeout(6000);
    console.log(before ? 'BEFORE' : 'AFTER', logs);
    await page.close();
  }
} finally { await browser.close(); unlinkSync('scripts/brain-before.tsx'); }
