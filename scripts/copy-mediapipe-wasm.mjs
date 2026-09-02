/**
 * Copies MediaPipe tasks-vision WASM files from node_modules to public/mediapipe/
 * so they can be served locally (offline support).
 * Also downloads the hand_landmarker.task model if not present.
 * Run: node scripts/copy-mediapipe-wasm.mjs
 */

import { cpSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dir = dirname(fileURLToPath(import.meta.url));
const wasmSrc = resolve(__dir, '../node_modules/@mediapipe/tasks-vision/wasm');
const dst     = resolve(__dir, '../public/mediapipe');

if (!existsSync(wasmSrc)) {
  console.warn('[setup-mediapipe] @mediapipe/tasks-vision wasm not found — run npm install first');
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
cpSync(wasmSrc, dst, { recursive: true });
console.log('[setup-mediapipe] WASM copied to public/mediapipe/');

const modelDst = resolve(dst, 'hand_landmarker.task');
if (existsSync(modelDst)) {
  console.log('[setup-mediapipe] hand_landmarker.task already present — done.');
  process.exit(0);
}

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
console.log('[setup-mediapipe] Downloading hand_landmarker.task (~8 MB)...');

function download(url, dest, redirects = 5) {
  if (redirects === 0) { console.error('[setup-mediapipe] Too many redirects'); return; }
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      download(res.headers.location, dest, redirects - 1);
      return;
    }
    if (res.statusCode !== 200) {
      console.error(`[setup-mediapipe] HTTP ${res.statusCode} — model not downloaded`);
      console.log('[setup-mediapipe] Gesture camera will load model from Google CDN on first use.');
      return;
    }
    const file = createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      console.log('[setup-mediapipe] hand_landmarker.task downloaded — gesture camera ready offline.');
    });
  }).on('error', (e) => {
    console.warn(`[setup-mediapipe] Model download failed: ${e.message}`);
    console.log('[setup-mediapipe] Gesture camera will load model from Google CDN on first use.');
  });
}

download(MODEL_URL, modelDst);
