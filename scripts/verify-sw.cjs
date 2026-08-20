const { chromium } = require('../node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

  console.log('Navigating to https://localhost:5173 ...');
  try {
    await page.goto('https://localhost:5173', { waitUntil: 'networkidle', timeout: 20000 });
  } catch (e) {
    console.log('goto note:', e.message.slice(0, 100));
  }

  await page.waitForTimeout(4000);

  // SW status
  const swStatus = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { supported: true, registered: false };
    return {
      supported: true,
      registered: true,
      scope: reg.scope,
      active: reg.active ? reg.active.state : null,
      installing: reg.installing ? reg.installing.state : null,
      waiting: reg.waiting ? reg.waiting.state : null,
    };
  });

  // Cache Storage
  const cacheInfo = await page.evaluate(async () => {
    const keys = await caches.keys();
    const result = {};
    for (const k of keys) {
      const c = await caches.open(k);
      result[k] = (await c.keys()).map(r => {
        const u = new URL(r.url);
        return u.pathname + (u.search || '');
      });
    }
    return { cacheNames: keys, entries: result };
  });

  console.log('\n=== SERVICE WORKER ===');
  console.log(JSON.stringify(swStatus, null, 2));

  console.log('\n=== CACHE STORAGE ===');
  const total = Object.values(cacheInfo.entries).reduce((s, a) => s + a.length, 0);
  console.log('Total entries:', total);
  for (const [name, urls] of Object.entries(cacheInfo.entries)) {
    console.log(`\n  [${name}] (${urls.length}):`);
    urls.slice(0, 6).forEach(u => console.log('   ', u));
    if (urls.length > 6) console.log(`   +${urls.length - 6} more`);
  }

  console.log('\n=== CONSOLE LOGS ===');
  logs.filter(l => l.includes('[SW]') || l.includes('error') || l.includes('Error')).forEach(l => console.log(l));
  if (logs.length > 0 && !logs.some(l => l.includes('[SW]'))) console.log('(no SW logs — other logs:', logs.slice(0,3).join('; '), ')');

  // Probe: offline reload
  console.log('\n=== OFFLINE RELOAD TEST ===');
  await ctx.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(2000);
    const title = await page.title().catch(() => '(error)');
    const hasRoot = await page.evaluate(() => !!document.getElementById('root')).catch(() => false);
    console.log('Title:', title, '| #root exists:', hasRoot);
  } catch (e) {
    console.log('Offline reload failed:', e.message.slice(0, 100));
  }
  await ctx.setOffline(false);

  await browser.close();
  console.log('\nDone.');
})();
