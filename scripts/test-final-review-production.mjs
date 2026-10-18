import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright';

const server = await preview({ preview: { host: '127.0.0.1', port: 5176, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let offline = false;
  await context.route('**/api/**', route => offline ? route.abort('internetdisconnected') : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pages: [], items: [], jobs: [], models: [], total: 0, byKind: {} }) }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5176');
  await page.getByTitle("Plus d'actions").waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByTitle("Plus d'actions").waitFor();
  const cache = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('docteur-db');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('pages', 'readwrite');
        tx.objectStore('pages').put({ id: 'pwa-offline', title: 'Offline production proof', kind: 'note', blocks: [], links: [], createdAt: 1, updatedAt: 1 }, 'pwa-offline');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    return urls;
  });
  assert.ok(cache.some(url => new URL(url).pathname === '/index.html'));
  assert.ok(cache.some(url => /\/assets\/index-.*\.js$/.test(new URL(url).pathname)));
  assert.equal(cache.some(url => new URL(url).port === '3001' || new URL(url).pathname.startsWith('/api/')), false);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Ouvrir la copie hors ligne' }).click();
  await page.getByText('Offline production proof', { exact: false }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS built production/PWA on 390px: SW controls navigation, shell is cached, API is not cached, offline restart opens the real IndexedDB snapshot');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
