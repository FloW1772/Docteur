// EETF V1 — deterministic FFmpeg derivation engine (EETF-3).
//
// Derives NEW assets from an existing EETF asset: resize (stretch / contain /
// pad), crop, thumbnail, format conversion (which is also the metadata-strip /
// normalisation operation). No AI, no model, no network, no texture-map
// synthesis (normal / roughness / metallic / AO / height are NOT produced here).
//
// Process safety (same rules as Media Studio):
//   - Root Policy MEDIA_TRANSCODE (module `media`) is enforced before EVERY
//     process start (probes included); a refusal means FFmpeg is never spawned;
//   - fixed binary, structured argv, shell:false; every value placed in argv is
//     a validated integer, an enum or a path built by the asset store;
//   - inputs are local files only: `-protocol_whitelist file`, `file:` paths,
//     and the demuxer is forced from the SNIFFED format (`png_pipe`, …);
//   - `-max_pixels` bounds the decoder itself (the EETF-2 header check is not
//     trusted alone); `-fs` bounds the output size;
//   - timeout and cancellation kill the whole process tree (process-tree.js).
//
// Determinism: single thread, bit-exact flags, fixed encoder settings per
// format, metadata and frame side data (EXIF, ICC…) removed. Same source + same
// params + same FFmpeg build → same bytes (asserted by the tests on this build).
//
// HDR honesty: EXR / HDR outputs made from (LDR) EETF sources are recorded as
// LDR_CONTENT_IN_HDR_CONTAINER, and the provenance states that values are the
// source's encoded values, NOT linearised scene-referred radiance.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killProcessTree } from './process-tree.js';
import {
  EetfError, FORMAT_EXT, FORMAT_MIME, HDR_CONTAINER_FORMATS, VARIANT_OPERATION, JOB_STATUS,
  validateJobParams, canonicalJson, sha256Hex, limit, assertUuid, freezeDeep,
} from './eetf-contracts.js';
import { sniffImage, assertImageBudget } from './eetf-asset-store.js';
import { assertStructurallyIntact } from './eetf-integrity.js';

const fail = (code, message, details) => { throw new EetfError(code, message, details); };

/** Job error codes written by the engine (EETF-3 error model). */
export const DERIVE_ERROR = Object.freeze({
  FFMPEG_UNAVAILABLE: 'FFMPEG_UNAVAILABLE', INVALID_SOURCE: 'INVALID_SOURCE', UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  PIXEL_LIMIT: 'PIXEL_LIMIT', DISK_LIMIT: 'DISK_LIMIT', TEMP_QUOTA: 'TEMP_QUOTA', TIMEOUT: 'TIMEOUT',
  TRANSCODE_FAILED: 'TRANSCODE_FAILED', OUTPUT_INVALID: 'OUTPUT_INVALID', ROOT_POLICY_DENIED: 'ROOT_POLICY_DENIED',
  ALPHA_NOT_SUPPORTED_BY_TARGET: 'ALPHA_NOT_SUPPORTED_BY_TARGET', INVALID_PARAMS: 'INVALID_PARAMS', PATH_REFUSED: 'PATH_REFUSED',
});
const PATH_ERRORS = new Set(['EETF_UNSAFE_PATH', 'EETF_PATH_ESCAPE', 'EETF_SYMLINK_REFUSED', 'EETF_UNSAFE_ROOT']);

/** Operations implemented by EETF-3 (a subset of VARIANT_OPERATION: no DERIVE_MAP, no TILE_PREVIEW). */
export const DERIVE_OPERATIONS = Object.freeze(['RESIZE', 'CROP', 'THUMBNAIL', 'CONVERT', 'TILE_PREVIEW']);

export const ARGV_PROFILE = 'eetf-ffmpeg-v1';

/** Fixed encoder settings per output format (the same for every job → deterministic). */
const ENCODERS = Object.freeze({
  // [EETF-CERT] explicit predictor: an EETF-normalised PNG is never byte-identical to FFmpeg's default (paeth) encoding,
  // so normalising an imported FFmpeg PNG yields a distinct DERIVED asset instead of deduplicating back to the SOURCE.
  PNG: { encoder: 'png', pix: (a) => (a ? 'rgba' : 'rgb24'), alpha: true, options: ['-pred', 'mixed'], bytesPerPixel: 4 },
  JPEG: { encoder: 'mjpeg', pix: () => 'yuvj444p', alpha: false, options: ['-q:v', '2'], bytesPerPixel: 3 },
  WEBP: { encoder: 'libwebp', pix: () => 'bgra', alpha: true, options: ['-lossless', '1', '-compression_level', '6'], bytesPerPixel: 4 },
  TIFF: { encoder: 'tiff', pix: (a) => (a ? 'rgba' : 'rgb24'), alpha: true, options: ['-compression_algo', 'deflate'], bytesPerPixel: 4 },
  EXR: { encoder: 'exr', pix: (a) => (a ? 'gbrapf32le' : 'gbrpf32le'), alpha: true, options: ['-compression', 'zip1'], bytesPerPixel: 16 },
  HDR: { encoder: 'hdr', pix: () => 'gbrpf32le', alpha: false, options: [], bytesPerPixel: 4 },
});
const DEMUXERS = Object.freeze({ PNG: 'png_pipe', JPEG: 'jpeg_pipe', WEBP: 'webp_pipe', TIFF: 'tiff_pipe', EXR: 'exr_pipe', HDR: 'hdr_pipe' });

const STDERR_CAP = 16_000;
const PIXEL_LIMIT_RE = /exceeds specified max pixel count|exceeds max pixel/i;

/**
 * Normalises DERIVE params against the source asset and computes the exact
 * output geometry. Throws EetfError (code EETF_*) for invalid requests.
 */
export function planDerivation(params, source) {
  const op = params.operation;
  if (!DERIVE_OPERATIONS.includes(op)) fail('EETF_DERIVE_OPERATION_UNSUPPORTED', `${op} is not implemented by the FFmpeg engine`);
  if (params.sourceAssetIds.length !== 1 || params.sourceAssetIds[0] !== source.id) fail('EETF_INVALID_PARAMS', 'a derivation reads exactly one source asset');
  const allowed = { RESIZE: ['width', 'height', 'fit', 'background', 'format'], CROP: ['x', 'y', 'width', 'height', 'format'], THUMBNAIL: ['maxSide', 'format'], CONVERT: ['format'], TILE_PREVIEW: ['grid', 'maxSide', 'format'] }[op];
  for (const k of Object.keys(params)) if (!['operation', 'sourceAssetIds', ...allowed].includes(k)) fail('EETF_INVALID_PARAMS', `${k} does not apply to ${op}`);
  const format = params.format ?? (op === 'THUMBNAIL' ? 'WEBP' : op === 'TILE_PREVIEW' ? 'PNG' : source.actualFormat);
  if (op === 'CONVERT' && !params.format) fail('EETF_INVALID_PARAMS', 'CONVERT needs a target format');
  const sw = source.width; const sh = source.height;
  let filters = []; let outW; let outH; let padded = false;
  const contain = (W, H, allowUpscale) => {
    const ratio = Math.min(W / sw, H / sh, allowUpscale ? Infinity : 1);
    return [Math.max(1, Math.round(sw * ratio)), Math.max(1, Math.round(sh * ratio))];
  };
  const scale = (w, h) => `scale=${w}:${h}:flags=lanczos+accurate_rnd+full_chroma_int`;
  if (op === 'RESIZE') {
    if (!params.width || !params.height) fail('EETF_INVALID_PARAMS', 'RESIZE needs width and height');
    const fit = params.fit ?? 'STRETCH';
    if (fit !== 'PAD' && params.background !== undefined) fail('EETF_INVALID_PARAMS', 'background only applies to fit PAD');
    if (fit === 'STRETCH') { outW = params.width; outH = params.height; filters = [scale(outW, outH)]; }
    else {
      const [cw, ch] = contain(params.width, params.height, true);
      filters = [scale(cw, ch)];
      if (fit === 'CONTAIN') { outW = cw; outH = ch; }
      else {
        const bg = params.background ?? 'TRANSPARENT';
        outW = params.width; outH = params.height; padded = bg === 'TRANSPARENT';
        const x = Math.floor((outW - cw) / 2); const y = Math.floor((outH - ch) / 2);
        if (padded) filters.push('format=rgba');
        filters.push(`pad=${outW}:${outH}:${x}:${y}:color=${padded ? '0x00000000' : `0x${bg}FF`}`);
      }
    }
  } else if (op === 'CROP') {
    const { x = 0, y = 0, width, height } = params;
    if (!width || !height) fail('EETF_INVALID_PARAMS', 'CROP needs width and height');
    if (x + width > sw || y + height > sh) fail('EETF_INVALID_PARAMS', 'the crop rectangle lies outside the source image');
    outW = width; outH = height; filters = [`crop=${width}:${height}:${x}:${y}`];
  } else if (op === 'THUMBNAIL') {
    const side = params.maxSide ?? 256;
    [outW, outH] = contain(side, side, false);
    if (outW !== sw || outH !== sh) filters = [scale(outW, outH)];
  } else if (op === 'TILE_PREVIEW') {
    // EETF-5: inspection only — the (possibly downscaled) tile repeated n × n; never upscaled, never "fixed"
    const n = params.grid ?? 2;
    const side = params.maxSide ?? limit('maxThumbnailSide');
    const [tw, th] = contain(Math.floor(side / n), Math.floor(side / n), false);
    if (tw !== sw || th !== sh) filters.push(scale(tw, th));
    const labels = (p) => Array.from({ length: n }, (_, i) => `[${p}${i}]`).join('');
    filters.push(`split=${n}${labels('h')};${labels('h')}hstack=inputs=${n},split=${n}${labels('v')};${labels('v')}vstack=inputs=${n}`);
    outW = tw * n; outH = th * n;
  } else {
    outW = sw; outH = sh;
  }
  if (outW > limit('maxImportSide') || outH > limit('maxImportSide') || outW * outH > limit('maxPixels')) fail('EETF_PIXEL_LIMIT', 'the output exceeds the pixel budget');
  const enc = ENCODERS[format];
  const wantAlpha = source.hasAlpha || padded;
  if (wantAlpha && !enc.alpha) fail('EETF_ALPHA_NOT_SUPPORTED_BY_TARGET', `${format} cannot keep the alpha channel; choose PNG, WEBP, TIFF or EXR`);
  return freezeDeep({ operation: op, format, outW, outH, filters, hasAlpha: wantAlpha, pixFmt: enc.pix(wantAlpha), encoder: enc.encoder });
}

/** Structured argv for one derivation. Every element is a constant, a validated number / enum, or a store-built path. */
export function buildFfmpegArgs({ plan, sourceFormat, inputPath, outputPath, maxDecodePixels, maxOutputBytes }) {
  const enc = ENCODERS[plan.format];
  const vf = ['sidedata=mode=delete', ...plan.filters, `format=${plan.pixFmt}`].join(',');
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    '-max_pixels', String(maxDecodePixels), '-protocol_whitelist', 'file',
    '-f', DEMUXERS[sourceFormat], '-i', `file:${inputPath}`,
    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    '-vf', vf, '-c:v', plan.encoder, '-pix_fmt', plan.pixFmt, ...enc.options,
    '-fs', String(maxOutputBytes), '-update', '1', '-n', `file:${outputPath}`,
  ];
}

function defaultDiskFree(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function dirBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const st = fs.lstatSync(path.join(dir, name));
    if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * @param {object} deps
 * @param {import('./eetf-store.js').EetfStore} deps.store
 * @param {(request: object) => unknown} deps.enforce Root Policy enforce (throws when refused)
 */
export function createEetfDerivationEngine({
  store, enforce, ffmpegBin = 'ffmpeg', spawnImpl = spawn, killTree = killProcessTree,
  diskFree = defaultDiskFree, timeoutMs = limit('derivationTimeoutMs'), tempQuotaBytes = limit('tempQuota'),
  minFreeDiskBytes = limit('minFreeDiskBytes'), maxDecodePixels = limit('maxPixels'), logger = null,
}) {
  if (!store || typeof enforce !== 'function') fail('EETF_ENGINE_CONFIG', 'store and enforce are required');
  let detected = null;
  let running = null; // { jobId, proc, cancelled, timedOut }
  const spawned = [];

  const policy = (stage) => enforce({ action: 'MEDIA_TRANSCODE', module: 'media', trustDomain: 'MEDIA', context: { engine: 'ffmpeg', networkClass: 'none', stage } });

  /** Root Policy, then a structured spawn. Resolves { code, stderr }; never a shell. */
  function runFfmpeg(args, { onSpawn, timeout, captureMaxBytes = 0 } = {}) {
    return new Promise((resolve) => {
      let stderr = ''; let settled = false;
      const out = []; let outBytes = 0; let overflow = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let proc;
      try {
        proc = spawnImpl(ffmpegBin, args, { shell: false, windowsHide: true, stdio: ['ignore', captureMaxBytes ? 'pipe' : 'ignore', 'pipe'] });
      } catch (e) { return done({ code: null, spawnError: e.code ?? e.message, stderr: '' }); }
      spawned.push(proc.pid);
      onSpawn?.(proc);
      let timer = null; let timedOut = false;
      if (timeout) timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeout);
      proc.stderr?.on('data', (d) => { if (stderr.length < STDERR_CAP) stderr += d; });
      // EETF-5 raw decode: stdout is bounded; past the cap the process tree is stopped
      proc.stdout?.on('data', (d) => {
        outBytes += d.length;
        if (outBytes > captureMaxBytes) { if (!overflow) { overflow = true; killTree(proc); } return; }
        out.push(d);
      });
      proc.on('error', (e) => { clearTimeout(timer); done({ code: null, spawnError: e.code ?? e.message, stderr, timedOut }); });
      proc.on('close', (code) => { clearTimeout(timer); done({ code, stderr, timedOut, overflow, stdout: captureMaxBytes ? Buffer.concat(out) : null }); });
    });
  }

  /**
   * EETF-5: decodes one asset to raw RGBA8 (for seam / alpha analysis). Same guarantees as a derivation:
   * single slot, source re-verified, Root Policy MEDIA_TRANSCODE before the spawn, -max_pixels, timeout,
   * stdout bounded to exactly width × height × 4 bytes. Throws EetfError on any failure.
   */
  async function decodeRgba(assetId) {
    if (running) fail('EETF_ENGINE_BUSY', 'the FFmpeg slot is busy');
    running = { jobId: null, proc: null, cancelled: false };
    try {
      const a = store.getAsset(assertUuid(assetId, 'asset id'));
      if (!store.verifyAsset(a.id)) fail('EETF_INVALID_SOURCE', 'the asset file is missing or no longer matches its sha256');
      if (a.width * a.height > limit('maxPixels')) fail('EETF_PIXEL_LIMIT', 'the asset exceeds the pixel budget');
      const caps = await detect();
      if (!caps.available) fail('EETF_FFMPEG_UNAVAILABLE', `FFmpeg is not available (${caps.reason})`);
      if (!caps.formats[a.actualFormat]?.read) fail('EETF_UNSUPPORTED_FORMAT', `this FFmpeg build cannot read ${a.actualFormat}`);
      policy('decode');
      const expected = a.width * a.height * 4;
      const r = await runFfmpeg([
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
        '-max_pixels', String(maxDecodePixels), '-protocol_whitelist', 'file',
        '-f', DEMUXERS[a.actualFormat], '-i', `file:${store.files.resolveAssetPath(a.storagePath)}`,
        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'sidedata=mode=delete,format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
      ], { timeout: timeoutMs, captureMaxBytes: expected, onSpawn: (p) => { running.proc = p; } });
      if (r.timedOut) fail('EETF_TIMEOUT', `decode exceeded ${timeoutMs} ms`);
      if (r.spawnError) fail('EETF_FFMPEG_UNAVAILABLE', `FFmpeg could not start (${r.spawnError})`);
      if (r.overflow) fail('EETF_OUTPUT_INVALID', 'decoded data larger than width × height × 4');
      if (r.code !== 0) fail(PIXEL_LIMIT_RE.test(r.stderr) ? 'EETF_PIXEL_LIMIT' : 'EETF_TRANSCODE_FAILED', `FFmpeg could not decode the asset (exit ${r.code})`);
      if (r.stdout.length !== expected) fail('EETF_OUTPUT_INVALID', `decoded ${r.stdout.length} bytes, expected ${expected}`);
      return Object.freeze({ width: a.width, height: a.height, hasAlphaChannel: a.hasAlpha, rgba: r.stdout, engineVersion: caps.version });
    } catch (e) {
      if (e?.rootPolicyDenied || e?.code === 'ROOT_POLICY_DENIED') fail('EETF_ROOT_POLICY_DENIED', e.message);
      throw e;
    } finally {
      running = null;
    }
  }

  /**
   * EETF-CERT: bounded decode check of an EXTERNAL file before it becomes an asset (uploads, Media Studio / Neurone
   * imports). Header sniff + budget + structure first (pure), then one full decode of the first frame to the null
   * muxer: single slot, Root Policy MEDIA_TRANSCODE before the spawn, -max_pixels, timeout, temp quota + free-disk
   * guard, no stdout. Accepted only when FFmpeg exits 0 with no error-level message (-xerror). The check file lives in
   * tmp/ and is removed in every case (purged at recovery if the process dies). Returns the sniffed header info.
   */
  async function validateDecodable(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail('EETF_EMPTY_FILE', 'empty file');
    if (buffer.length > limit('maxFileSize')) fail('EETF_FILE_TOO_LARGE', 'file too large');
    const info = sniffImage(buffer);
    assertImageBudget(info);
    assertStructurallyIntact(buffer, info);
    if (running) fail('EETF_ENGINE_BUSY', 'the FFmpeg slot is busy');
    running = { jobId: null, proc: null, cancelled: false };
    let checkFile = null;
    try {
      const caps = await detect();
      if (!caps.available) fail('EETF_FFMPEG_UNAVAILABLE', `FFmpeg is not available (${caps.reason}): the file cannot be verified`);
      if (!caps.formats[info.format]?.read) fail('EETF_UNSUPPORTED_FORMAT', `this FFmpeg build cannot read ${info.format}`);
      const tmpDir = store.files.resolveInside('tmp');
      if (dirBytes(tmpDir) + buffer.length > tempQuotaBytes) fail('EETF_TEMP_QUOTA', 'the temporary quota would be exceeded');
      if (diskFree(store.files.root) < buffer.length + minFreeDiskBytes) fail('EETF_DISK_LIMIT', 'not enough free disk space');
      policy('validate');
      checkFile = store.files.writeCheckFile(buffer, info.format);
      const r = await runFfmpeg([
        '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-filter_threads', '1',
        '-max_pixels', String(maxDecodePixels), '-protocol_whitelist', 'file',
        '-f', DEMUXERS[info.format], '-i', `file:${checkFile}`,
        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'null', '-',
      ], { timeout: timeoutMs, onSpawn: (p) => { running.proc = p; } });
      if (r.timedOut) fail('EETF_TIMEOUT', `decode check exceeded ${timeoutMs} ms`);
      if (r.spawnError) fail('EETF_FFMPEG_UNAVAILABLE', `FFmpeg could not start (${r.spawnError})`);
      if (r.code !== 0 || r.stderr.trim() !== '') fail(PIXEL_LIMIT_RE.test(r.stderr) ? 'EETF_IMAGE_TOO_LARGE' : 'EETF_MALFORMED_IMAGE', 'the image cannot be decoded completely');
      return info;
    } catch (e) {
      if (e?.rootPolicyDenied || e?.code === 'ROOT_POLICY_DENIED') fail('EETF_ROOT_POLICY_DENIED', e.message);
      throw e;
    } finally {
      if (checkFile) store.files.removeCheckFile(checkFile);
      running = null;
    }
  }

  /** Detects the FFmpeg build once: version + the encoders / demuxers EETF needs. */
  async function detect() {
    if (detected) return detected;
    policy('probe');
    const ver = await runFfmpegCapture(['-hide_banner', '-version']);
    if (ver.spawnError || ver.code !== 0) return { available: false, reason: ver.spawnError ?? `exit ${ver.code}` };
    const version = /ffmpeg version (\S+)/.exec(ver.out)?.[1]?.slice(0, 80) ?? 'unknown';
    policy('probe');
    const encoders = (await runFfmpegCapture(['-hide_banner', '-encoders'])).out;
    policy('probe');
    const demuxers = (await runFfmpegCapture(['-hide_banner', '-demuxers'])).out;
    const formats = {};
    for (const [fmt, e] of Object.entries(ENCODERS)) {
      formats[fmt] = {
        write: new RegExp(`^\\s*V\\S*\\s+${e.encoder}\\s`, 'm').test(encoders),
        read: new RegExp(`^\\s*D\\S*\\s+${DEMUXERS[fmt]}\\s`, 'm').test(demuxers),
      };
    }
    detected = freezeDeep({ available: true, version, formats });
    return detected;
  }

  /** Like runFfmpeg but captures stdout (probes only, small outputs). Resolves { out, code, spawnError }. */
  function runFfmpegCapture(args) {
    return new Promise((resolve) => {
      let out = ''; let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let proc;
      try { proc = spawnImpl(ffmpegBin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return done({ out: '', code: null, spawnError: e.code ?? e.message }); }
      spawned.push(proc.pid);
      const timer = setTimeout(() => killTree(proc), 15_000);
      proc.stdout?.on('data', (d) => { if (out.length < 400_000) out += d; });
      proc.on('error', (e) => { clearTimeout(timer); done({ out, code: null, spawnError: e.code ?? e.message }); });
      proc.on('close', (code) => { clearTimeout(timer); done({ out, code, spawnError: null }); });
    });
  }

  /** Validates and queues a DERIVE job (nothing runs). Throws on invalid params. */
  function submit({ sourceAssetId, operation, ...rest }) {
    if (!VARIANT_OPERATION[operation] || !DERIVE_OPERATIONS.includes(operation)) fail('EETF_DERIVE_OPERATION_UNSUPPORTED', `${String(operation).slice(0, 40)} is not an EETF-3 operation`);
    const params = { operation, sourceAssetIds: [assertUuid(sourceAssetId, 'source asset id')], ...rest };
    const v = validateJobParams('DERIVE', params);
    planDerivation(v.params, store.getAsset(sourceAssetId)); // geometry / alpha / budget checked before queueing
    return store.createJob({ kind: 'DERIVE', params: v.params, provider: 'ffmpeg' });
  }

  /** Runs one QUEUED DERIVE job to a final state. Single slot: refuses while another job runs. */
  async function run(jobId) {
    if (running) fail('EETF_ENGINE_BUSY', 'a derivation is already running');
    const job = store.getJob(jobId);
    if (job.kind !== 'DERIVE') fail('EETF_INVALID_JOB_KIND', 'the FFmpeg engine only runs DERIVE jobs');
    store.startJob(jobId);
    running = { jobId, proc: null, cancelled: false };
    const tmpOut = [];
    const failWith = (code, message) => {
      if (running.cancelled) return store.getJob(jobId);
      return store.failJob(jobId, { code, message: message ? String(message).slice(0, 400) : null });
    };
    try {
      return await execute(job, tmpOut, failWith);
    } catch (e) {
      logger?.warn?.({ jobId, err: e.message }, 'EETF derivation error');
      if (e?.rootPolicyDenied || e?.code === 'ROOT_POLICY_DENIED') return failWith(DERIVE_ERROR.ROOT_POLICY_DENIED, e.message);
      if (PATH_ERRORS.has(e?.code)) return failWith(DERIVE_ERROR.PATH_REFUSED, e.message);
      const known ={ EETF_PIXEL_LIMIT: 'PIXEL_LIMIT', EETF_ALPHA_NOT_SUPPORTED_BY_TARGET: 'ALPHA_NOT_SUPPORTED_BY_TARGET' }[e.code];
      return failWith(known ?? (e.code?.startsWith('EETF_') ? DERIVE_ERROR.INVALID_PARAMS : DERIVE_ERROR.TRANSCODE_FAILED), e.message);
    } finally {
      for (const p of tmpOut) fs.rmSync(p, { force: true });
      running = null;
    }
  }

  async function execute(job, tmpOut, failWith) {
    const jobId = job.id;
    const params = job.params;
    // ── source: still present, unchanged, and what the DB says it is ──
    let source;
    try { source = store.getAsset(params.sourceAssetIds[0]); } catch { return failWith(DERIVE_ERROR.INVALID_SOURCE, 'source asset not found'); }
    if (!store.verifyAsset(source.id)) return failWith(DERIVE_ERROR.INVALID_SOURCE, 'the source file is missing or no longer matches its sha256');
    const inputPath = store.files.resolveAssetPath(source.storagePath);
    const head = Buffer.alloc(Math.min(source.sizeBytes, 65_536));
    const fd = fs.openSync(inputPath, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    let sniffed;
    try { sniffed = sniffImage(head); } catch { return failWith(DERIVE_ERROR.INVALID_SOURCE, 'the source header is not readable'); }
    if (sniffed.format !== source.actualFormat || sniffed.width !== source.width || sniffed.height !== source.height) return failWith(DERIVE_ERROR.INVALID_SOURCE, 'the source header disagrees with its record');
    if (source.width * source.height > limit('maxPixels') || source.sizeBytes > limit('maxFileSize')) return failWith(DERIVE_ERROR.PIXEL_LIMIT, 'the source exceeds the pixel / size budget');

    const plan = planDerivation(params, source);
    store.updateProgress(jobId, 0.05);

    // ── engine capability, disk, temp quota ──
    try { policy('probe'); } catch (e) { if (e?.rootPolicyDenied || e?.code === 'ROOT_POLICY_DENIED') return failWith(DERIVE_ERROR.ROOT_POLICY_DENIED, e.message); throw e; }
    const caps = await detect();
    if (!caps.available) return failWith(DERIVE_ERROR.FFMPEG_UNAVAILABLE, `FFmpeg is not available (${caps.reason})`);
    if (!caps.formats[source.actualFormat]?.read) return failWith(DERIVE_ERROR.UNSUPPORTED_FORMAT, `this FFmpeg build cannot read ${source.actualFormat}`);
    if (!caps.formats[plan.format]?.write) return failWith(DERIVE_ERROR.UNSUPPORTED_FORMAT, `this FFmpeg build cannot write ${plan.format}`);
    const estimate = Math.ceil(plan.outW * plan.outH * ENCODERS[plan.format].bytesPerPixel * 1.05) + 65_536;
    const tmpDir = store.files.resolveInside('tmp');
    if (dirBytes(tmpDir) + 2 * estimate > tempQuotaBytes) return failWith(DERIVE_ERROR.TEMP_QUOTA, 'the temporary quota would be exceeded');
    if (diskFree(store.files.root) < 2 * estimate + minFreeDiskBytes) return failWith(DERIVE_ERROR.DISK_LIMIT, 'not enough free disk space');
    if (running.cancelled) return store.getJob(jobId);

    // ── Root Policy, then FFmpeg ──
    try { policy('transcode'); } catch (e) { if (e?.rootPolicyDenied || e?.code === 'ROOT_POLICY_DENIED') return failWith(DERIVE_ERROR.ROOT_POLICY_DENIED, e.message); throw e; }
    const outputPath = store.files.resolveInside(`tmp/${jobId}.out.${FORMAT_EXT[plan.format]}`);
    tmpOut.push(outputPath);
    const args = buildFfmpegArgs({ plan, sourceFormat: source.actualFormat, inputPath, outputPath, maxDecodePixels, maxOutputBytes: limit('maxFileSize') + 1 });
    store.updateProgress(jobId, 0.1);
    const r = await runFfmpeg(args, { timeout: timeoutMs, onSpawn: (proc) => { running.proc = proc; } });
    running.proc = null;
    if (running.cancelled) return store.getJob(jobId);
    if (r.timedOut) return failWith(DERIVE_ERROR.TIMEOUT, `FFmpeg exceeded ${timeoutMs} ms; its process tree was stopped`);
    if (r.spawnError) return failWith(DERIVE_ERROR.FFMPEG_UNAVAILABLE, `FFmpeg could not start (${r.spawnError})`);
    if (r.code !== 0) {
      if (PIXEL_LIMIT_RE.test(r.stderr)) return failWith(DERIVE_ERROR.PIXEL_LIMIT, 'FFmpeg refused to decode: the picture exceeds max_pixels');
      return failWith(DERIVE_ERROR.TRANSCODE_FAILED, `FFmpeg exited with code ${r.code}`);
    }
    store.updateProgress(jobId, 0.8);

    // ── validate what was REALLY produced ──
    let st;
    try { st = fs.lstatSync(outputPath); } catch { return failWith(DERIVE_ERROR.OUTPUT_INVALID, 'FFmpeg produced no file'); }
    if (!st.isFile() || st.size === 0 || st.size > limit('maxFileSize')) return failWith(DERIVE_ERROR.OUTPUT_INVALID, 'the output is empty, not a file or too large');
    const buffer = fs.readFileSync(outputPath);
    let out;
    try { out = sniffImage(buffer); } catch { return failWith(DERIVE_ERROR.OUTPUT_INVALID, 'the output is not a readable image'); }
    if (out.format !== plan.format || out.width !== plan.outW || out.height !== plan.outH) return failWith(DERIVE_ERROR.OUTPUT_INVALID, `the output is ${out.format} ${out.width}×${out.height}, expected ${plan.format} ${plan.outW}×${plan.outH}`);
    if (plan.hasAlpha && !out.hasAlpha) return failWith(DERIVE_ERROR.OUTPUT_INVALID, 'the alpha channel was lost');
    if (running.cancelled) return store.getJob(jobId);
    store.updateProgress(jobId, 0.9);

    // ── content-addressed result: same bytes → the existing asset ──
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const variantParams = { ...params, format: plan.format };
    delete variantParams.sourceAssetIds;
    let asset = store.getAssetBySha(sha);
    let reused = Boolean(asset);
    if (!asset) {
      const derivationKey = sha256Hex(canonicalJson({ sourceSha256: source.sha256, params: variantParams, engine: caps.version, profile: ARGV_PROFILE }));
      const provenance = store.createProvenance({
        provider: 'ffmpeg', model: null, engineVersion: caps.version, width: plan.outW, height: plan.outH, strictLocal: true,
        sources: [{ assetId: source.id, relation: 'DERIVED_FROM' }],
        parameters: {
          ...variantParams, encoder: plan.encoder, pixFmt: plan.pixFmt, profile: ARGV_PROFILE, derivationKey, metadata: 'STRIPPED',
          ...(HDR_CONTAINER_FORMATS.has(plan.format) ? { values: 'SOURCE_ENCODED_VALUES_NOT_LINEARIZED', dynamicRange: 'LDR_CONTENT_IN_HDR_CONTAINER' } : {}),
        },
      });
      const registered = store.registerAsset({
        buffer, declaredMime: FORMAT_MIME[plan.format], contentDynamicRange: HDR_CONTAINER_FORMATS.has(plan.format) ? 'LDR' : undefined,
        role: 'DERIVED', provenanceId: provenance.id, sourceJobId: jobId, displayName: `${params.operation.toLowerCase()}-${source.id.slice(0, 8)}`,
      });
      asset = registered.asset; reused = registered.existed;
    }
    if (asset.id !== source.id) store.createVariant({ sourceAssetId: source.id, variantAssetId: asset.id, operation: params.operation, params: variantParams });
    if (running.cancelled) return store.getJob(jobId);
    const done = store.completeJob(jobId, { outputAssetIds: [asset.id] });
    logger?.info?.({ jobId, assetId: asset.id, reused }, 'EETF derivation completed');
    return done;
  }

  /** Cancellation: QUEUED → CANCELLED; RUNNING → CANCELLED + the FFmpeg process tree is killed. */
  async function cancel(jobId) {
    const result = store.cancelJob(jobId);
    if (result.interruptRequired && running?.jobId === jobId) {
      running.cancelled = true;
      if (running.proc) await killTree(running.proc);
    }
    return result;
  }

  /** Runs the oldest QUEUED DERIVE job, if any and if the slot is free. */
  async function runNext() {
    if (running) return null;
    const next = store.listJobs({ status: JOB_STATUS.QUEUED, limit: 200 }).filter(j => j.kind === 'DERIVE').at(-1);
    return next ? run(next.id) : null;
  }

  return Object.freeze({
    detect, submit, run, runNext, cancel, decodeRgba, validateDecodable,
    isRunning: () => running?.jobId ?? null,
    /** PIDs of every process this engine started (tests check none survives). */
    spawnedPids: () => [...spawned],
  });
}
