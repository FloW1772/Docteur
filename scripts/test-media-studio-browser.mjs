// Media Studio V1 — REAL MediaStudioModal against the REAL media-studio route + service in-process (real FFmpeg /
// ffprobe, real Root Policy decision, in-memory SQLite, temp folder), then the REAL App: Media Reader → "Envoyer au
// Media Studio". Synthetic media generated locally with ffmpeg. No real DB, no real data folder, no Internet.
// Usage: node scripts/test-media-studio-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite } from '../cortex-server/src/lib/sqlite.js';
import { enforce } from '../cortex-server/src/lib/root-policy/index.js';
import { createMediaStudioService } from '../cortex-server/src/lib/media-studio.js';
import { createMediaStudioStore } from '../cortex-server/src/lib/media-studio-store.js';
import { createMediaStudioRoute } from '../cortex-server/src/routes/media-studio.js';
import { startHarness, openApp, until, sleep } from './audit-queue-lib.mjs';

initSqlite(':memory:');
let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); assertions += 1; };

// ─── synthetic media ───────────────────────────────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-media-studio-browser-'));
const root = path.join(dir, 'studio');
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
const F = (n) => path.join(dir, n);
ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis', '-shortest', F('clip.webm'));
ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', F('tone.wav'));
ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', F('voice.mp3'));
ff('-f', 'lavfi', '-i', 'testsrc=size=400x300', '-frames:v', '1', F('still.png'));
ff('-f', 'lavfi', '-i', 'testsrc=size=200x200', '-frames:v', '1', F('docteur.png'));
const bytes = (n) => fs.readFileSync(F(n));
function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true }).toString());
  return { duration: Number(j.format.duration), streams: j.streams.map(s => ({ type: s.codec_type, codec: s.codec_name, w: s.width, h: s.height })) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ─── backend in-process (restartable: same DB + folder, new service instance) ───────────────────────────────────────
const IMAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
const store = createMediaStudioStore();
const spawned = [];
const spawnImpl = (bin, args, opts) => { const p = spawn(bin, args, opts); if (bin === 'ffmpeg') spawned.push(p); return p; };
function boot() {
  const service = createMediaStudioService({ rootDir: root, store, enforce, spawnImpl, resolveDocteurImage: (id) => (id === IMAGE_ID ? F('docteur.png') : null) });
  const recovered = service.recoverAfterRestart();
  return { service, api: createMediaStudioRoute({ service }), recovered };
}
let srv = boot();
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true', 'access-control-expose-headers': '*' };
async function proxyStudio(route) {
  const req = route.request();
  const u = new URL(req.url());
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => ['content-type', 'range'].includes(k)));
  const body = ['GET', 'HEAD'].includes(req.method()) ? null : req.postDataBuffer();
  const res = await srv.api.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers, ...(body ? { body } : {}) });
  const out = { ...cors };
  for (const k of ['content-type', 'content-disposition', 'content-range', 'accept-ranges']) if (res.headers.get(k)) out[k] = res.headers.get(k);
  return route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
}
const projectOf = async (id) => (await (await srv.api.request(`/media-studio/projects/${id}`)).json()).project;

// ─── Part A: the studio itself ────────────────────────────────────────────────────────────────────────────────────
const PORT = 5259;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/media-studio-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-media-studio', plugins: [react()], optimizeDeps: { entries: ['scripts/media-studio-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [] };

async function openStudio() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', proxyStudio);
  await ctx.route('**/__ms', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__ms`);
  await page.getByRole('dialog', { name: 'Media Studio' }).waitFor({ timeout: 30_000 });
  return { ctx, page };
}
const status = (page) => page.getByTestId('ms-export').getAttribute('data-export-status');
const videoClips = (page) => page.locator('.ms-track[data-track="V1"] .ms-clip');
const audioClips = (page) => page.locator('.ms-track[data-track="A1"] .ms-clip');
const notice = (page) => page.locator('.ms-main [role="status"].tb-notice');
const alertText = async (page) => (await page.locator('.ms-main .tb-error[role="alert"]').innerText().catch(() => ''));
async function waitIdle(page) { await until(async () => (await page.locator('.ms-main button[disabled]:has-text("Rogner"), .ms-main button[disabled]:has-text("Couper")').count()) === 0, 10_000, 50); }

let pid = null;
try {
  const { ctx, page } = await openStudio();

  // ═══ 1. Project + import (chunked upload, server-side type check) ═══
  ok(await page.getByText('Créez un projet ou importez un média').isVisible(), 'empty state');
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByTestId('ms-sequence-preview').waitFor();
  pid = await page.locator('#ms-project').inputValue();
  ok(/^[0-9a-f-]{36}$/.test(pid), 'project created and opened');
  await page.getByLabel('Médias à importer', { exact: true }).setInputFiles([
    { name: 'clip.webm', mimeType: 'video/webm', buffer: bytes('clip.webm') },
    { name: 'tone.wav', mimeType: 'audio/wav', buffer: bytes('tone.wav') },
    { name: '../../secret/still.png', mimeType: 'image/png', buffer: bytes('still.png') },
  ]);
  ok(await until(async () => (await page.locator('.ms-asset').count()) === 3), '3 assets imported');
  ok(await until(async () => /3 média\(s\) ajouté\(s\)/.test(await notice(page).innerText().catch(() => ''))), 'import notice');
  deq(await page.locator('.ms-asset').evaluateAll(els => els.map(e => [e.dataset.asset, e.dataset.kind])), [['clip.webm', 'video'], ['tone.wav', 'audio'], ['still.png', 'image']], 'kinds decided from the bytes; hostile path stripped');
  await page.getByLabel('Médias à importer', { exact: true }).setInputFiles({ name: 'evil.mp4', mimeType: 'video/mp4', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
  ok(await until(async () => (await page.locator('.ms-side [data-operation-status="error"]').count()) === 1), 'unsupported content refused with an explicit error');
  ok(/non pris en charge|reconnu|Format/i.test(await page.locator('.ms-side [data-operation-status="error"]').innerText()), 'clear message');
  eq(await page.locator('.ms-asset').count(), 3, 'nothing added');

  // ═══ 2. Timeline: add, trim, split, reorder, image duration ═══
  await page.getByRole('button', { name: 'Ajouter clip.webm à la piste vidéo', exact: true }).click();
  await until(async () => (await videoClips(page).count()) === 1);
  await page.getByRole('button', { name: 'Ajouter still.png à la piste vidéo', exact: true }).click();
  await until(async () => (await videoClips(page).count()) === 2);
  await page.getByRole('button', { name: 'Ajouter tone.wav à la piste audio', exact: true }).click();
  ok(await until(async () => (await audioClips(page).count()) === 1), 'audio clip on A1');
  ok(await until(async () => (await page.getByTestId('ms-duration').innerText()) === 'Durée : 0:05.0'), 'sequence duration 2 s + 3 s image');

  await page.getByRole('button', { name: /^Clip 1 : clip\.webm/ }).click();
  await page.getByTestId('ms-inspector').waitFor();
  await page.getByLabel('Entrée (s)', { exact: true }).fill('0.2');
  await page.getByLabel('Sortie (s)', { exact: true }).fill('1.8');
  await page.getByRole('button', { name: 'Rogner', exact: true }).click();
  ok(await until(async () => (await page.getByTestId('ms-duration').innerText()) === 'Durée : 0:04.6'), 'trim reflected in the duration');
  await page.getByLabel('Couper à (s depuis le début du clip)', { exact: true }).fill('0.8');
  await page.getByRole('button', { name: 'Couper', exact: true }).click();
  ok(await until(async () => (await videoClips(page).count()) === 3), 'split → 3 video clips');
  let p = await projectOf(pid);
  deq(p.clips.filter(c => c.trackId === 'V1').map(c => [c.inMs, c.outMs]), [[200, 1000], [1000, 1800], [0, 3000]], 'trim + split saved');
  await page.getByRole('button', { name: 'Déplacer still.png vers la gauche', exact: true }).click();
  await until(async () => (await videoClips(page).nth(1).getAttribute('data-clip')) === 'still.png');
  await page.getByRole('button', { name: 'Déplacer still.png vers la gauche', exact: true }).click();
  ok(await until(async () => (await videoClips(page).first().getAttribute('data-clip')) === 'still.png'), 'reorder: image first');
  await page.getByRole('button', { name: /^Clip 1 : still\.png/ }).click();
  await page.getByLabel('Durée (s)', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Appliquer la durée', exact: true }).click();
  ok(await until(async () => (await page.getByTestId('ms-duration').innerText()) === 'Durée : 0:02.6'), 'image duration 1 s → 2.6 s');
  p = await projectOf(pid);
  deq(p.clips.filter(c => c.trackId === 'V1').map(c => p.assets.find(a => a.id === c.assetId).name), ['still.png', 'clip.webm', 'clip.webm'], 'order saved');

  // ═══ 3. Audio controls: position, volume, fades, mute, track mute/volume, delete; invalid edit refused ═══
  await page.getByRole('button', { name: /^Audio : tone\.wav/ }).click();
  await page.getByLabel('Position dans la séquence (s)', { exact: true }).fill('0.3');
  await page.getByRole('button', { name: 'Placer', exact: true }).click();
  ok(await until(async () => (await audioClips(page).first().getAttribute('data-start')) === '300'), 'audio moved to 0.3 s');
  await page.getByLabel('Volume (%)', { exact: true }).fill('60');
  await page.getByLabel('Fondu d’entrée (s)', { exact: true }).fill('0.2');
  await page.getByLabel('Fondu de sortie (s)', { exact: true }).fill('0.2');
  await page.getByRole('button', { name: 'Appliquer l’audio', exact: true }).click();
  ok(await until(async () => { const c = (await projectOf(pid)).clips.find(x => x.trackId === 'A1'); return c.volume === 0.6 && c.fadeInMs === 200 && c.fadeOutMs === 200; }), 'volume + fades saved');
  ok(await until(async () => (await notice(page).innerText().catch(() => '')) === 'Réglages audio appliqués.'), 'UI confirms the audio settings');
  await page.getByLabel('Fondu d’entrée (s)', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Appliquer l’audio', exact: true }).click();
  ok(await until(async () => /Fondus incompatibles/.test(await alertText(page))), 'invalid fade refused with a clear message');
  eq((await projectOf(pid)).clips.find(x => x.trackId === 'A1').fadeInMs, 200, 'project unchanged by the refused edit');
  await page.getByLabel('Muet', { exact: true }).click();
  ok(await until(async () => (await projectOf(pid)).clips.find(x => x.trackId === 'A1').muted === true), 'clip muted');
  ok(await until(async () => page.getByLabel('Muet', { exact: true }).isChecked()), 'checkbox reflects the saved state');
  await page.getByLabel('Muet', { exact: true }).click();
  ok(await until(async () => (await projectOf(pid)).clips.find(x => x.trackId === 'A1').muted === false), 'clip unmuted');
  await page.getByRole('button', { name: 'Couper le son de la piste audio', exact: true }).click();
  ok(await until(async () => (await projectOf(pid)).tracks.find(t => t.id === 'A1').muted === true), 'audio track muted');
  await page.getByRole('button', { name: 'Rétablir le son de la piste audio', exact: true }).click();
  ok(await until(async () => (await projectOf(pid)).tracks.find(t => t.id === 'A1').muted === false), 'audio track restored');
  await page.getByLabel('Volume de la piste vidéo (%)', { exact: true }).fill('80');
  await page.getByLabel('Volume de la piste vidéo (%)', { exact: true }).press('Enter');
  ok(await until(async () => (await projectOf(pid)).tracks.find(t => t.id === 'V1').volume === 0.8), 'video track volume');
  await page.getByRole('button', { name: 'Ajouter tone.wav à la piste audio', exact: true }).click();
  await until(async () => (await audioClips(page).count()) === 2);
  await audioClips(page).nth(1).click();
  await page.getByRole('button', { name: 'Supprimer le clip', exact: true }).click();
  ok(await until(async () => (await audioClips(page).count()) === 1), 'clip deleted');
  eq((await projectOf(pid)).assets.length, 3, 'deleting a clip keeps the media');
  await page.getByRole('button', { name: 'Retirer tone.wav du projet', exact: true }).click();
  ok(await until(async () => /utilisé dans la timeline/.test(await alertText(page))), 'a media in use cannot be removed');

  // ═══ 4. Sequence preview (plays the timeline in order) ═══
  const preview = page.getByTestId('ms-sequence-preview');
  const firstId = (await projectOf(pid)).clips.find(c => c.trackId === 'V1').id;
  await page.getByTestId('ms-preview-play').click();
  ok(await until(async () => (await preview.getAttribute('data-playing')) === 'true', 3_000, 30), 'preview playing');
  eq(await preview.getAttribute('data-current-clip'), firstId, 'starts on the first clip of the sequence');
  ok(await until(async () => (await preview.getAttribute('data-current-clip')) !== firstId, 4_000, 30), 'moves on to the next clip');
  ok(await until(async () => page.evaluate(() => { const v = document.querySelector('.ms-stage video'); return !!v && !v.paused && v.currentTime > 0.2; }), 3_000, 30), 'video clip actually playing in the stage');
  ok(await until(async () => page.evaluate(() => [...document.querySelectorAll('.ms-preview audio')].some(a => !a.paused)), 3_000, 30), 'audio track clip playing');
  ok(await until(async () => (await preview.getAttribute('data-playing')) === 'false', 6_000, 50), 'stops at the end');
  eq(await page.getByTestId('ms-preview-time').innerText(), '0:02.6 / 0:02.6', 'end of sequence');

  // ═══ 5. Persistence: reload, then a backend restart ═══
  const saved = await projectOf(pid);
  await page.reload();
  await page.getByRole('dialog', { name: 'Media Studio' }).waitFor();
  ok(await until(async () => (await page.locator('#ms-project').inputValue()) === pid), 'reload reopens the project');
  ok(await until(async () => (await videoClips(page).count()) === 3 && (await audioClips(page).count()) === 1), 'timeline restored after reload');
  eq(await page.getByTestId('ms-duration').innerText(), 'Durée : 0:02.6');
  deq(await projectOf(pid), saved, 'identical state after reload');
  srv = boot();
  await page.reload();
  await page.getByRole('dialog', { name: 'Media Studio' }).waitFor();
  ok(await until(async () => (await videoClips(page).count()) === 3), 'timeline restored after backend restart');
  deq(await projectOf(pid), saved, 'identical state after restart');

  // ═══ 6. Export success: queue → progress → completed; real MP4 checked ═══
  await page.getByTestId('ms-export-start').click();
  ok(await until(async () => ['QUEUED', 'RUNNING', 'COMPLETED'].includes(await status(page)), 5_000, 30), 'export queued');
  ok(await until(async () => (await status(page)) === 'COMPLETED', 90_000), `export completed (${await status(page)})`);
  await page.getByTestId('ms-export-result').waitFor();
  const jobs = (await (await srv.api.request(`/media-studio/projects/${pid}`)).json()).jobs;
  const done = jobs[0];
  eq(done.status, 'COMPLETED');
  const out = probe(srv.service.exportFile(done.id).file);
  ok(Math.abs(out.duration - 2.6) < 0.2, `exported duration ${out.duration}`);
  deq(out.streams.map(s => s.type).sort(), ['audio', 'video'], 'video + audio streams');
  deq(out.streams.filter(s => s.type === 'video').map(s => [s.codec, s.w, s.h]), [['h264', 1280, 720]]);
  ok(await until(async () => page.evaluate(() => { const v = document.querySelector('[data-testid="ms-export-result"] video'); return !!v && v.readyState >= 1 && Math.abs(v.duration - 2.6) < 0.25; }), 15_000), 'export preview loads in the browser');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Télécharger le MP4', exact: true }).click()]);
  ok(/^export-[0-9a-f]{8}\.mp4$/.test(download.suggestedFilename()), `download name ${download.suggestedFilename()}`);
  const dl = path.join(dir, 'downloaded.mp4');
  await download.saveAs(dl);
  ok(Math.abs(probe(dl).duration - 2.6) < 0.2, 'downloaded file is the export');

  // ═══ 7. Export cancel: FFmpeg killed, no orphan, no partial file ═══
  await page.getByRole('button', { name: /^Clip 1 : still\.png/ }).click();
  await page.getByLabel('Durée (s)', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Appliquer la durée', exact: true }).click();
  await until(async () => (await page.getByTestId('ms-duration').innerText()) === 'Durée : 10:01.6');
  await page.getByLabel('Format', { exact: true }).selectOption('1920x1080');
  await waitIdle(page);
  const before = spawned.length;
  await page.getByTestId('ms-export-start').click();
  ok(await until(async () => (await status(page)) === 'RUNNING' && spawned.length === before + 1, 20_000), 'long export running');
  ok(await until(async () => (await page.locator('.ms-export [role="progressbar"]').count()) === 1, 10_000), 'progress bar shown');
  ok(await until(async () => Number(await page.locator('.ms-export [role="progressbar"]').getAttribute('aria-valuenow').catch(() => '0')) > 0, 30_000), 'real progress > 0 %');
  const proc = spawned.at(-1);
  await page.getByRole('button', { name: 'Annuler l’export MP4', exact: true }).click();
  ok(await until(async () => (await status(page)) === 'CANCELLED', 15_000), 'export cancelled');
  ok(await until(() => !alive(proc.pid), 10_000), 'no orphan FFmpeg process');
  const cancelled = (await (await srv.api.request(`/media-studio/projects/${pid}`)).json()).jobs[0];
  eq(fs.existsSync(path.join(root, 'projects', pid, 'exports', `${cancelled.id}.mp4`)), false, 'partial output removed');
  ok(/annulé/i.test(await page.getByTestId('ms-export').innerText()), 'cancel shown to the user');
  eq(srv.service.runningProcess(), null, 'no running process');
  await page.getByRole('button', { name: /^Clip 1 : still\.png/ }).click();
  await page.getByLabel('Durée (s)', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Appliquer la durée', exact: true }).click();
  await page.getByLabel('Format', { exact: true }).selectOption('640x360');
  await waitIdle(page);

  // ═══ 8. Export failure is explicit; retry after fixing succeeds ═══
  const clipAsset = (await projectOf(pid)).assets.find(a => a.name === 'clip.webm');
  const clipFile = srv.service.assetFile(pid, clipAsset.id).file;
  const backup = path.join(dir, 'clip.backup');
  fs.renameSync(clipFile, backup);
  await page.getByTestId('ms-export-start').click();
  ok(await until(async () => (await status(page)) === 'FAILED', 60_000), 'export failed');
  const failText = await page.getByTestId('ms-export').innerText();
  ok(/FFmpeg a échoué/.test(failText), 'reason shown');
  ok(!failText.includes(dir), 'internal paths not shown');
  fs.renameSync(backup, clipFile);
  await page.getByTestId('ms-export').getByRole('button', { name: 'Réessayer', exact: true }).click();
  ok(await until(async () => (await status(page)) === 'COMPLETED', 90_000), 'retry succeeds');
  ok(Math.abs(probe(srv.service.exportFile((await (await srv.api.request(`/media-studio/projects/${pid}`)).json()).jobs[0].id).file).streams.find(s => s.type === 'video').w - 640) === 0, 'new format applied (640×360)');

  // ═══ 9. Restart during an export: reported, not resumed, no orphan ═══
  await page.getByRole('button', { name: /^Clip 1 : still\.png/ }).click();
  await page.getByLabel('Durée (s)', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Appliquer la durée', exact: true }).click();
  await waitIdle(page);
  const before2 = spawned.length;
  await page.getByTestId('ms-export-start').click();
  ok(await until(async () => (await status(page)) === 'RUNNING' && spawned.length === before2 + 1, 20_000), 'export running before restart');
  const proc2 = spawned.at(-1);
  await srv.service.shutdown();
  srv = boot();
  ok(await until(() => !alive(proc2.pid), 10_000), 'FFmpeg stopped with the server');
  await page.reload();
  await page.getByRole('dialog', { name: 'Media Studio' }).waitFor();
  ok(await until(async () => (await status(page)) === 'FAILED'), 'interrupted export shown as failed after restart');
  await page.locator('.ms-jobs summary').click();
  ok(/interrompu par un redémarrage/.test(await page.locator('.ms-jobs').innerText()), 'history explains the interruption');
  eq(srv.service.runningProcess(), null, 'nothing resumed by itself');

  eq(net.errors.length, 0, `no page errors: ${net.errors.join(' | ')}`);
  eq(net.external.filter(u => /^https?:/i.test(u)).length, 0, `no external request: ${net.external.join(', ')}`);
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}

// ─── Part B: REAL App — Media Reader → "Envoyer au Media Studio" ─────────────────────────────────────────────────────
const HOST = 'https://media.docteur-test.example';
const NOCORS = 'https://nocors.docteur-test.example';
const DOCTEUR_IMAGE = `http://127.0.0.1:3001/api/image/${IMAGE_ID}`;
const L = { video: `${HOST}/films/clip.webm`, audio: `${HOST}/voice.mp3`, image: DOCTEUR_IMAGE, nocors: `${NOCORS}/clip.webm`, pdf: `${HOST}/doc.pdf`, youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
const now = Date.now();
const neuron = {
  id: 'studio-bridge', title: 'Pont Media Studio', kind: 'note', createdAt: now - 1000, updatedAt: now, links: [], metadata: {},
  blocks: Object.entries(L).map(([k, url], i) => ({ id: `b${i}`, type: 'paragraph', content: `${k} ${url}` })),
};
const h = await startHarness({ port: 5261 });
const reader = (page) => page.locator('[data-testid="media-reader"]');
async function openFor(page, url) {
  const anchor = page.locator(`a[href="${url}"]`).first();
  await anchor.waitFor({ timeout: 10_000 });
  await anchor.locator('xpath=following-sibling::button[@data-testid="open-in-docteur"]').first().click();
  await reader(page).waitFor({ timeout: 5_000 });
}
const ready = (page) => until(async () => (await reader(page).getAttribute('data-phase').catch(() => null)) === 'READY', 15_000, 50);
const studio = (page) => page.getByRole('dialog', { name: 'Media Studio' });
try {
  const app = await openApp(h, {
    seedPages: [neuron], indexMs: 20,
    extra: async ({ route, p, m, json }) => {
      if (p.startsWith('/api/media-studio/')) { await proxyStudio(route); return true; }
      if (p === `/api/image/${IMAGE_ID}`) { await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: bytes('docteur.png') }); return true; }
      if (p === '/api/agents/pending-outputs') { await json(route, []); return true; }
      if (p.startsWith('/api/neuron/') && m === 'GET') { await json(route, { page: neuron }); return true; }
      return false;
    },
  });
  const { page, net: appNet } = app;
  const ranged = (route, buf, type, headers) => {
    const r = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '');
    if (!r) return route.fulfill({ status: 200, headers: { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(buf.length) }, body: buf });
    const start = r[1] ? Number(r[1]) : 0; const end = r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1;
    return route.fulfill({ status: 206, headers: { ...headers, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}` }, body: buf.subarray(start, end + 1) });
  };
  await page.route(`${HOST}/**`, route => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/films/clip.webm') return ranged(route, bytes('clip.webm'), 'video/webm', { 'access-control-allow-origin': '*' });
    if (name === '/voice.mp3') return ranged(route, bytes('voice.mp3'), 'audio/mpeg', { 'access-control-allow-origin': '*' });
    return route.fulfill({ status: 404, body: 'nf' });
  });
  // A site without CORS: the <video> element plays it, but a script read is refused by the browser (a TypeError for the
  // page). Playwright's fulfill does not apply CORS, so the refusal is reproduced at the same point: script reads fail.
  await page.route(`${NOCORS}/**`, route => (route.request().resourceType() === 'fetch' ? route.abort('accessdenied') : ranged(route, bytes('clip.webm'), 'video/webm', {})));
  await page.route('https://www.youtube-nocookie.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>yt</title>' }));
  await page.locator('.sidebar-item[data-neuron-id="studio-bridge"]').first().dispatchEvent('click');
  await page.locator(`a[href="${L.video}"]`).first().waitFor({ timeout: 15_000 });

  // the action exists only for loaded video / audio / image
  await openFor(page, L.youtube);
  await sleep(400);
  eq(await page.getByTestId('media-reader-send-studio').count(), 0, 'not offered for YouTube');
  await page.getByTestId('media-reader-close').click();

  // video from a site that allows it → imported with its provenance
  await openFor(page, L.video);
  ok(await ready(page), 'video ready in the reader');
  await page.getByTestId('media-reader-send-studio').click();
  await studio(page).waitFor({ timeout: 15_000 });
  eq(await reader(page).count(), 0, 'reader closed');
  ok(await until(async () => /« clip\.webm » ajouté au projet/.test(await studio(page).innerText()), 30_000), 'studio confirms the import');
  const bridgePid = await page.locator('#ms-project').inputValue();
  let bp = await projectOf(bridgePid);
  const imported = bp.assets.find(a => a.name === 'clip.webm' && a.source.type === 'media-reader');
  ok(imported, 'asset imported into the most recent project');
  eq(imported.source.url, L.video, 'provenance recorded');
  eq(imported.kind, 'video');
  ok(await studio(page).locator('.ms-asset[data-asset="clip.webm"]').last().isVisible(), 'visible in the asset list');
  await studio(page).getByRole('button', { name: 'Fermer Media Studio', exact: true }).click();

  // audio
  await openFor(page, L.audio);
  ok(await ready(page), 'audio ready');
  await page.getByTestId('media-reader-send-studio').click();
  ok(await until(async () => /« voice\.mp3 » ajouté/.test(await studio(page).innerText().catch(() => '')), 30_000), 'audio imported');
  bp = await projectOf(bridgePid);
  eq(bp.assets.find(a => a.name === 'voice.mp3')?.kind, 'audio');
  await studio(page).getByRole('button', { name: 'Fermer Media Studio', exact: true }).click();

  // Docteur image → copied server-side from the image module (no browser round trip)
  await openFor(page, L.image);
  ok(await ready(page), 'Docteur image ready');
  await page.getByTestId('media-reader-send-studio').click();
  ok(await until(async () => /ajouté au projet/.test(await studio(page).innerText().catch(() => '')), 30_000), 'Docteur image imported');
  bp = await projectOf(bridgePid);
  deq(bp.assets.filter(a => a.source.type === 'docteur-image').map(a => [a.kind, a.source.imageId]), [['image', IMAGE_ID]], 'imported through import-image');
  await studio(page).getByRole('button', { name: 'Fermer Media Studio', exact: true }).click();

  // a site that does not allow reading → explicit, actionable error; nothing imported
  const countBefore = (await projectOf(bridgePid)).assets.length;
  await openFor(page, L.nocors);
  ok(await ready(page), 'no-CORS video still plays in the reader');
  await page.getByTestId('media-reader-send-studio').click();
  ok(await until(async () => /n’autorise pas Docteur à récupérer ce média/.test(await studio(page).innerText().catch(() => '')), 20_000), 'clear message when the source refuses');
  eq((await projectOf(bridgePid)).assets.length, countBefore, 'nothing imported');
  await studio(page).getByRole('button', { name: 'Fermer Media Studio', exact: true }).click();

  eq(appNet.errors.length, 0, `no page errors: ${appNet.errors.join(' | ')}`);
  eq(appNet.external.filter(u => /^https?:/i.test(u)).length, 0, `no external request: ${appNet.external.join(', ')}`);
  await app.ctx.close();
  console.log(`MEDIA_STUDIO_BROWSER_PASS assertions=${assertions}`);
} finally {
  await srv.service.shutdown();
  await h.browser.close();
  await h.server.close();
  for (const p of spawned) if (alive(p.pid)) { console.error(`ORPHAN ffmpeg ${p.pid}`); process.exitCode = 1; }
  fs.rmSync(dir, { recursive: true, force: true });
}
