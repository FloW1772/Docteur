/**
 * Copies Tesseract.js worker + WASM core from node_modules to public/tesseract/,
 * and downloads the French + English trained-data files, so OCR runs 100% local
 * with zero runtime network calls (no CDN fallback — see useScreenOcr.ts).
 * Run: node scripts/copy-tesseract-assets.mjs
 */

import { cpSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dir = dirname(fileURLToPath(import.meta.url));
const dst = resolve(__dir, '../public/tesseract');
const langDst = resolve(dst, 'lang-data');

const workerSrc = resolve(__dir, '../node_modules/tesseract.js/dist/worker.min.js');
const coreSrc = resolve(__dir, '../node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js');
const coreWasmSrc = resolve(__dir, '../node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm');

if (!existsSync(workerSrc) || !existsSync(coreSrc)) {
  console.warn('[setup-tesseract] tesseract.js / tesseract.js-core not found — run npm install first');
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
mkdirSync(langDst, { recursive: true });

cpSync(workerSrc, resolve(dst, 'worker.min.js'));
cpSync(coreSrc, resolve(dst, 'tesseract-core-simd-lstm.wasm.js'));
cpSync(coreWasmSrc, resolve(dst, 'tesseract-core-simd-lstm.wasm'));
console.log('[setup-tesseract] worker + WASM core copied to public/tesseract/');

function download(url, dest, redirects = 5) {
  return new Promise((resolvePromise) => {
    if (redirects === 0) { console.error('[setup-tesseract] Too many redirects'); resolvePromise(); return; }
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, dest, redirects - 1).then(resolvePromise);
        return;
      }
      if (res.statusCode !== 200) {
        console.error(`[setup-tesseract] HTTP ${res.statusCode} for ${url} — not downloaded`);
        console.log('[setup-tesseract] OCR for this language will be unavailable until the file is added manually.');
        resolvePromise();
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolvePromise(); });
    }).on('error', (e) => {
      console.warn(`[setup-tesseract] Download failed for ${url}: ${e.message}`);
      resolvePromise();
    });
  });
}

const LANGS = ['eng', 'fra'];

for (const lang of LANGS) {
  const dest = resolve(langDst, `${lang}.traineddata.gz`);
  if (existsSync(dest)) {
    console.log(`[setup-tesseract] ${lang}.traineddata.gz already present — skipped.`);
    continue;
  }
  console.log(`[setup-tesseract] Downloading ${lang}.traineddata.gz...`);
  // eslint-disable-next-line no-await-in-loop
  await download(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, dest);
}

console.log('[setup-tesseract] done — OCR ready fully offline.');
