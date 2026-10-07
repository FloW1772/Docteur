// Model Router V1 — REAL ModelRouterSection against the REAL /model-router route in-process, with a
// fake Ollama runtime (no real model, no download, no network, no real DB).
// Usage: node scripts/test-model-router-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createModelRouterRoute } from '../cortex-server/src/routes/model-router.js';

let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

// Fake runtime, controlled by the test.
const state = { up: true, chats: [] };
const INSTALLED = [
  { name: 'llama3.2:3b', size: 2_019_393_189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
  { name: 'llava:7b', size: 4_733_363_377, details: { family: 'llama', parameter_size: '7B', quantization_level: 'Q4_0' } },
  { name: 'qwen2.5:14b-instruct-q3_K_M', size: 7_339_204_710, details: { family: 'qwen2', parameter_size: '14.8B', quantization_level: 'Q3_K_M' } },
  { name: 'mystery:latest', size: 1_000_000_000 },
];
const SHOWS = {
  'llama3.2:3b': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131_072 } },
  'llava:7b': { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 4_096 } },
  'qwen2.5:14b-instruct-q3_K_M': { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32_768 } },
  'mystery:latest': null,
};
const down = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
const client = {
  list: async () => (state.up ? { models: INSTALLED } : down()),
  show: async ({ model }) => (state.up ? SHOWS[model] : down()),
  ps: async () => (state.up ? { models: [{ name: 'llama3.2:3b', size: 3_000_000_000, size_vram: 2_000_000_000 }] } : down()),
  chat: async (req) => {
    state.chats.push(req);
    if (!state.up) down();
    if (req.model === 'qwen2.5:14b-instruct-q3_K_M') throw new Error('llama runner process has terminated: cudaMalloc failed: out of memory');
    return { message: { content: `Réponse de ${req.model}` } };
  },
};
const settings = { strict_local_mode: true, cloud_enabled: false, chat_model: 'mistral-nemo:12b-instruct-2407-q4_K_M', powerful_model: 'qwen2.5:14b-instruct-q3_K_M', fallback_model: 'llama3.2:3b' };
const api = createModelRouterRoute({ client, getSettings: () => settings, getKeys: () => ({}), getHardware: async () => ({ gpus: [{ name: 'GPU test', vramBytes: 8 * 1_073_741_824 }], totalRamBytes: 32 * 1_073_741_824 }) });

const PORT = 5253;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/model-router-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-model-router', plugins: [react()], optimizeDeps: { entries: ['scripts/model-router-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };

async function openPage(viewport = { width: 1300, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await api.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: cors, body: await res.text() });
  });
  await ctx.route('**/__mr', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__mr`);
  await page.getByRole('region', { name: 'Routeur de modèles' }).waitFor({ timeout: 30_000 });
  await page.locator('[data-model="llama3.2:3b"]').waitFor({ timeout: 15_000 });
  return { ctx, page };
}
const row = (page, name) => page.locator(`[data-model="${name}"]`);
const setCaps = async (page, wanted) => {
  for (const label of ['Texte', 'Vision', 'Audio', 'Embedding', 'Outils', 'Sortie structurée', 'Génération d’images', 'Long contexte']) {
    await page.getByLabel(label, { exact: true }).setChecked(wanted.includes(label));
  }
};

let failed = null;
try {
  const { ctx, page } = await openPage();
  // Registry with honest facts.
  ok((await page.getByRole('status').first().innerText()).includes('Strict Local actif'), 'Strict Local state shown');
  const pending = await page.getByRole('list', { name: 'Cibles en attente d’identification' }).innerText();
  ok(pending.includes('Qwen (optimisé faible VRAM) : identité exacte requise — non intégré (MODEL_IDENTITY_REQUIRED)'), 'Qwen pending');
  ok(pending.includes('Kolibri : identité exacte requise — non intégré (MODEL_IDENTITY_REQUIRED)'), 'Kolibri pending');
  ok((await row(page, 'llama3.2:3b').innerText()).includes('Q4_K_M (runtime)'), 'quantization from the runtime');
  ok((await row(page, 'llama3.2:3b').innerText()).includes('chargé : 1.9 Go VRAM + 954 Mo RAM'), 'real VRAM/RAM split of the loaded model');
  ok((await row(page, 'llava:7b').innerText()).includes('TEXT, STRUCTURED_OUTPUT, VISION'), 'capabilities from the runtime');
  const mystery = await row(page, 'mystery:latest').innerText();
  ok(mystery.includes('inconnues') && mystery.includes('inconnu'), 'unknown stays unknown');
  ok((await page.locator('[data-provider="gemini"]').innerText()).includes('Bloqué (Strict Local)'));
  eq(await page.locator('.mr-table th[scope="col"]').count(), 7, 'table headers scoped');

  // AUTO capability routing.
  await setCaps(page, ['Vision']);
  await page.getByRole('button', { name: 'Voir la décision' }).click();
  await page.locator('.mr-decision').waitFor();
  ok((await page.locator('.mr-decision').innerText()).includes('Décision : llava:7b via ollama (LOCAL)'), 'AUTO picks the vision model');
  eq(state.chats.length, 0, 'a decision never calls a model');
  await setCaps(page, ['Texte']);
  await page.getByRole('button', { name: 'Voir la décision' }).click();
  ok(await until(async () => (await page.locator('.mr-decision').innerText()).includes('qwen2.5:14b-instruct-q3_K_M')), 'AUTO follows the configured preference');
  await setCaps(page, ['Audio']);
  await page.getByRole('button', { name: 'Voir la décision' }).click();
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('NO_MODEL_FOR_CAPABILITIES')), 'no audio model → clear error');

  // Manual selection + run.
  await setCaps(page, ['Texte']);
  await page.getByLabel('Manuelle').check();
  await page.getByLabel('Modèle', { exact: true }).selectOption('llama3.2:3b');
  await page.getByLabel('Message de test (optionnel)').fill('Réponds ok');
  await page.getByRole('button', { name: 'Envoyer au modèle choisi' }).click();
  await page.locator('.mr-result').waitFor();
  ok((await page.locator('.mr-result').innerText()).includes('Réponse de llama3.2:3b'), 'manual run on exactly the chosen model');
  eq(state.chats.at(-1).model, 'llama3.2:3b');
  // num_ctx / num_gpu reach the runtime; invalid values are refused before any call.
  await page.getByLabel('num_ctx').fill('8192');
  await page.getByLabel('num_gpu').fill('10');
  await page.getByRole('button', { name: 'Envoyer au modèle choisi' }).click();
  ok(await until(async () => state.chats.at(-1)?.options?.num_ctx === 8192 && state.chats.at(-1)?.options?.num_gpu === 10), 'runtime options passed');
  const callsBefore = state.chats.length;
  await page.getByLabel('num_ctx').fill('99999999');
  await page.getByRole('button', { name: 'Envoyer au modèle choisi' }).click();
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('INVALID_RUNTIME_OPTIONS')), 'invalid num_ctx refused');
  eq(state.chats.length, callsBefore, 'refused before reaching the runtime');
  await page.getByLabel('num_ctx').fill('');
  await page.getByLabel('num_gpu').fill('');

  // Out of memory: clear message + hint, no other model tried.
  await page.getByLabel('Modèle', { exact: true }).selectOption('qwen2.5:14b-instruct-q3_K_M');
  const beforeOom = state.chats.length;
  await page.getByRole('button', { name: 'Envoyer au modèle choisi' }).click();
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('OUT_OF_MEMORY')), 'OOM classified');
  ok((await page.getByRole('alert').innerText()).includes('plus quantifié'), 'actionable hint');
  eq(state.chats.length, beforeOom + 1, 'exactly one call, no fallback');

  // Unknown capabilities: manual allowed with a warning.
  await page.getByLabel('Modèle', { exact: true }).selectOption('mystery:latest');
  await page.getByRole('button', { name: 'Voir la décision' }).click();
  ok(await until(async () => (await page.locator('.mr-decision').innerText()).includes('Capacités non vérifiées')), 'unverified capabilities warned');

  // Runtime stopped.
  state.up = false;
  await page.getByRole('button', { name: 'Actualiser le registre des modèles' }).click();
  ok(await until(async () => (await page.locator('[data-provider="ollama"]').innerText()).includes('Runtime arrêté')), 'runtime stopped shown');
  await page.getByLabel('AUTO (déterministe)').check();
  await page.getByRole('button', { name: 'Voir la décision' }).click();
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('RUNTIME_UNAVAILABLE')), 'no silent cloud: runtime problem reported');
  state.up = true;
  await ctx.close();

  // Mobile width: no horizontal page scroll (the table scrolls inside its wrapper).
  const mobile = await openPage({ width: 375, height: 800 });
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no horizontal page scroll at 375 px (${overflow})`);
  await mobile.ctx.close();

  eq(net.errors.length, 0, `no page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, 'no external request');
} catch (error) {
  failed = error;
} finally {
  await browser.close();
  await server.close();
}
if (failed) throw failed;
console.log(`MODEL_ROUTER_BROWSER_PASS assertions=${assertions}`);
