import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const origin = process.env.FRONTEND_TEST_URL ?? 'http://127.0.0.1:5183';
const browser = await chromium.launch({headless:true});
async function setup(screen = 'ocr', {failImport = false, invalidImage = false} = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(r.url()));
  await page.addInitScript(() => {
    window.unhandled = [];
    window.addEventListener('unhandledrejection', e => window.unhandled.push(String(e.reason)));
  });
  await page.route('**/__frontend_test', route => route.fulfill({contentType:'text/html',body:
    '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>'}));
  if (failImport) await page.route(/\/node_modules\/.*tesseract.*\.js(?:\?|$)/, route => route.fulfill({
    contentType:'text/javascript',body:'throw new Error("OCR module unavailable");',
  }));
  await page.goto(`${origin}/__frontend_test`);
  const mount = () => page.evaluate(async ({screen,invalidImage}) => {
    const harness = await import('/scripts/frontend-browser-harness.jsx');
    harness.mount(screen,invalidImage);
  },{screen,invalidImage});
  return {page,context,errors,requests,mount,async verify() {
    assert.deepEqual(errors,[]);
    assert.deepEqual(await page.evaluate(()=>window.unhandled),[]);
    assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
    assert.ok(!requests.some(url => /\/cortex-server\/|__vite-browser-external/.test(url)));
    await context.close();
  }};
}

try {
  const ocr = await setup();
  await ocr.mount();
  assert.ok(!ocr.requests.some(url=>/node_modules\/.*tesseract/.test(url)),'OCR stays lazy');
  await ocr.page.getByRole('button',{name:'Extraire le texte',exact:true}).click();
  await ocr.page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('CORTEX'),null,{timeout:60000});
  assert.match(await ocr.page.getByRole('textbox').inputValue(),/HELLO CORTEX 123/);
  assert.ok(ocr.requests.some(url=>/\/node_modules\/\.vite\/deps\/tesseract/.test(url)),'Vite converted the CommonJS entry');
  assert.ok(!ocr.requests.some(url=>/^https?:/.test(url)&&!url.startsWith(origin)),'OCR assets stay local');
  await ocr.verify();
  console.log('PASS: real OCR worker/WASM/languages, lazy ESM import, local assets, no require global');

  const failed = await setup('ocr',{failImport:true});
  await failed.mount();
  const extract = failed.page.getByRole('button',{name:'Extraire le texte',exact:true});
  for (let i=0;i<2;i++) {
    await extract.click();
    await failed.page.getByText('OCR module unavailable',{exact:true}).waitFor();
    assert.ok(await extract.isEnabled(),'failed import must release busyRef for retry');
  }
  await failed.verify();
  console.log('PASS: failed lazy import handled in UI; retry enabled; no unhandled rejection');

  const invalid = await setup('ocr',{invalidImage:true});
  await invalid.mount();
  await invalid.page.getByRole('button',{name:'Extraire le texte',exact:true}).click();
  await invalid.page.getByText('Image invalide',{exact:true}).waitFor();
  await invalid.verify();
  console.log('PASS: preprocessing failure handled by capture modal');

  const video = await setup('video');
  let created = 0, polls = 0;
  await video.page.route('**/api/video-summary/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    let body, status = 200;
    if(pathname.endsWith('/estimate')) body={ok:true,duration_s:60,duration_label:'1 min',chunk_count_estimate:1,total_minutes_estimate_local:1,groq_available:false,requires_confirmation:false};
    else if(pathname.endsWith('/jobs') && req.method()==='GET') body={jobs:[]};
    else if(pathname.endsWith('/jobs') && req.method()==='POST') {
      assert.equal(req.postDataJSON().url,'https://www.youtube.com/watch?v=test');
      created++;status=201;body={jobId:'browser-test'};
    } else {polls++;body={job:{id:'browser-test',status:polls===1?'downloading':'error',current_step:polls===1?'Téléchargement':'Erreur',error_message:'Le site refuse le téléchargement de cette vidéo.',disk_bytes:0},segments:[]};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body),headers:{'Access-Control-Allow-Origin':'*'}});
  });
  await video.mount();
  await video.page.getByPlaceholder('https://...').fill('https://www.youtube.com/watch?v=test');
  await video.page.getByRole('button',{name:'Estimer',exact:true}).click();
  await video.page.getByRole('button',{name:'Lancer le résumé',exact:true}).click();
  await video.page.getByText('Le site refuse le téléchargement de cette vidéo.',{exact:true}).waitFor();
  await video.page.waitForTimeout(3300);
  assert.equal(created,1);assert.equal(polls,2,'no more polls after terminal error and parent rerender');
  await video.page.evaluate(()=>window.testRoot.unmount());
  await video.verify();
  console.log('PASS: video UI estimate, HTTP job creation, polling, backend error displayed, polling stopped');
} finally {await browser.close();}
