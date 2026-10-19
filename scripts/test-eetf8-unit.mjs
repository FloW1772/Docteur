// [EETF V1] EETF-8 — unit tests of the pure integration model + Media Reader recognition of EETF assets (Node type
// stripping) + a static audit of the EETF-8 front-end files. Usage: node --test scripts/test-eetf8-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  INTEGRATION_CODES, INTEGRATION_MESSAGES, integrationCode, integrationMessage, neuronCompatibility, mediaStudioCompatibility,
  studioAssetToEetfCompatibility, studioFileMime, dynamicRangeLabel, roleLabel, classificationLabel, linkLabel, studioOriginOf, NEURON_IMAGE_MAX_BYTES,
} from '../src/lib/eetf/integration-model.ts';
import { FORBIDDEN_CLAIMS } from '../src/lib/eetf/ui-model.ts';
import { classifyMediaResource } from '../src/lib/media/media-resource.ts';

const API = 'http://127.0.0.1:3001';
const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const noInternals = (s) => assert.equal(/[A-Za-z]:\\|\/Users\/|SELECT |sqlite|stack|undefined|null/.test(s), false, s);
const noForbidden = (s) => { for (const w of FORBIDDEN_CLAIMS) assert.equal(s.includes(w), false, `"${w}" in "${s}"`); assert.equal(/\bTRUE HDR\b|\bHDRI\b(?! \))/.test(s.replace('pas un HDRI', '')), false, s); };

test('error vocabulary: the 8 product codes, every backend / bridge code folds into one, messages are clear and clean', () => {
  assert.deepEqual([...INTEGRATION_CODES], ['UNSUPPORTED_MEDIA', 'INVALID_SOURCE', 'ASSET_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'PIXEL_LIMIT', 'FORMAT_UNSUPPORTED', 'ENGINE_BUSY', 'EETF_DISABLED']);
  const cases = {
    UNSUPPORTED_MEDIA: ['UNSUPPORTED_MEDIA', 'EETF_UNSUPPORTED_MIME', 'MIME_MISMATCH', 'MALFORMED_IMAGE', 'UNSUPPORTED_FORMAT', 'CORRUPT_MEDIA', 'EMPTY_FILE'],
    INVALID_SOURCE: ['INVALID_SOURCE', 'EETF_SOURCE_MISMATCH', 'CHECKSUM_MISMATCH', 'LINK_CONTENT_MISMATCH', 'INVALID_ORIGIN'],
    ASSET_NOT_FOUND: ['ASSET_NOT_FOUND', 'NOT_FOUND', 'HTTP_404', 'PROJECT_NOT_FOUND'],
    SOURCE_UNAVAILABLE: ['SOURCE_UNAVAILABLE', 'ASSET_FILE_MISSING'],
    PIXEL_LIMIT: ['PIXEL_LIMIT', 'IMAGE_TOO_LARGE', 'FILE_TOO_LARGE'],
    FORMAT_UNSUPPORTED: ['FORMAT_UNSUPPORTED'],
    ENGINE_BUSY: ['ENGINE_BUSY', 'EETF_ENGINE_BUSY'],
    EETF_DISABLED: ['EETF_DISABLED', 'HTTP_503'],
  };
  for (const [code, raws] of Object.entries(cases)) for (const raw of raws) assert.equal(integrationCode(raw), code, raw);
  for (const raw of [null, undefined, '', 'RANDOM', '<script>', 'PROVIDER_TIMEOUT']) assert.equal(integrationCode(raw), null, String(raw));
  for (const c of INTEGRATION_CODES) { const m = INTEGRATION_MESSAGES[c]; assert.ok(m.length > 10); noInternals(m); }
  assert.equal(integrationMessage('<img onerror=1>', 'X'), 'X');
});

test('surface compatibility: Neurone (PNG/JPEG/WebP ≤ 5 MB), Media Studio (PNG/JPEG/WebP), studio → EETF (images, no GIF)', () => {
  for (const f of ['PNG', 'JPEG', 'WEBP']) { assert.deepEqual(neuronCompatibility({ format: f, sizeBytes: 1000 }), { ok: true }); assert.deepEqual(mediaStudioCompatibility({ format: f }), { ok: true }); }
  for (const f of ['TIFF', 'EXR', 'HDR']) {
    const n = neuronCompatibility({ format: f, sizeBytes: 10 });
    assert.equal(n.ok, false); assert.equal(n.code, 'FORMAT_UNSUPPORTED'); assert.match(n.reason, /aperçu PNG/);
    assert.equal(mediaStudioCompatibility({ format: f }).code, 'FORMAT_UNSUPPORTED');
  }
  assert.equal(neuronCompatibility({ format: 'PNG', sizeBytes: NEURON_IMAGE_MAX_BYTES + 1 }).code, 'PIXEL_LIMIT');
  assert.deepEqual(studioAssetToEetfCompatibility({ kind: 'image', file: 'a.png' }), { ok: true });
  assert.deepEqual(studioAssetToEetfCompatibility({ kind: 'image', file: 'a.webp' }), { ok: true });
  assert.equal(studioAssetToEetfCompatibility({ kind: 'image', file: 'a.gif' }).code, 'UNSUPPORTED_MEDIA');
  assert.equal(studioAssetToEetfCompatibility({ kind: 'video', file: 'a.mp4' }).code, 'UNSUPPORTED_MEDIA');
  assert.equal(studioFileMime('x.jpg'), 'image/jpeg'); assert.equal(studioFileMime('x.gif'), null); assert.equal(studioFileMime('x.png.exe'), null);
});

test('wording: LDR in an HDR container is never "HDR"; roles / classifications / links honest and sanitised', () => {
  assert.equal(dynamicRangeLabel('LDR'), 'LDR');
  assert.match(dynamicRangeLabel('LDR_CONTENT_IN_HDR_CONTAINER'), /contenu LDR dans un conteneur HDR \(pas un HDRI\)/);
  assert.equal(dynamicRangeLabel('HDR'), 'LDR', 'an unknown / HDR value is never echoed as HDR');
  for (const r of ['SOURCE', 'GENERATED', 'DERIVED', 'PBR_COMPLETE']) noForbidden(roleLabel(r));
  assert.match(classificationLabel('ENVIRONMENT_PANORAMA_REFERENCE'), /projection non certifiée/);
  assert.equal(classificationLabel('<b>X</b>'), 'X', 'unknown classification sanitised (markup dropped)');
  for (const c of ['TEXTURE_BASE_COLOR', 'ENVIRONMENT_SKYBOX_PREVIEW']) noForbidden(classificationLabel(c));
  assert.match(linkLabel({ direction: 'IMPORT', system: 'NEURON_IMAGE', ref: { imageId: `${ID}.png` }, verification: 'SERVER_RESOLVED' }), /^Importé depuis image de neurone 3f2b8c1e… — lu et vérifié par Docteur$/);
  assert.match(linkLabel({ direction: 'EXPORT', system: 'MEDIA_STUDIO', ref: { projectId: ID, mediaAssetId: ID }, verification: 'CONTENT_SHA256_MATCH' }), /^Copié vers Media Studio .* empreinte SHA-256 identique$/);
});

test('Media Studio origin: ids / hash / enums only, derivedFrom bounded', () => {
  const o = studioOriginOf({ id: ID, sha256: 'a'.repeat(64), role: 'DERIVED', format: 'PNG', sourceJobId: ID, createdAt: '2026-10-13T00:00:00.000Z' }, { operation: 'CONVERT', derivedFrom: Array(12).fill(ID) });
  assert.deepEqual(Object.keys(o).sort(), ['assetId', 'createdAt', 'derivedFrom', 'format', 'jobId', 'operation', 'role', 'sha256', 'type']);
  assert.equal(o.type, 'eetf'); assert.equal(o.derivedFrom.length, 8);
  assert.equal(JSON.stringify(o).includes('\\'), false);
});

test('Media Reader: only the exact EETF asset route on the Docteur origin is an EETF asset', () => {
  const c = (url, extra = {}) => classifyMediaResource({ url, ...extra }, { apiOrigin: API });
  const good = c(`${API}/api/image-generation/eetf/assets/${ID}/file`);
  assert.deepEqual([good.kind, good.eetfAssetId, good.docteurLocal, good.blocked], ['image', ID, true, null]);
  assert.equal(c(`${API}/api/image-generation/eetf/assets/${ID}/file`, { mimeType: 'image/x-exr' }).eetfAssetId, ID, 'EXR MIME still an EETF image (viewer decides)');
  for (const url of [
    `${API}/api/image-generation/eetf/assets/${ID}/file?x=1`, `${API}/api/image-generation/eetf/assets/${ID}/file#a`,
    `${API}/api/image-generation/eetf/assets/${ID.toUpperCase()}/file`, `${API}/api/image-generation/eetf/assets/not-a-uuid/file`,
    `${API}/api/image-generation/eetf/assets/${ID}`, `${API}/api/image-generation/eetf/assets/${ID}/../../x/file`,
    `http://127.0.0.1:8188/api/image-generation/eetf/assets/${ID}/file`, `https://evil.example/api/image-generation/eetf/assets/${ID}/file`,
  ]) assert.equal(c(url).eetfAssetId, null, url);
  assert.equal(c(`http://127.0.0.1:8188/api/image-generation/eetf/assets/${ID}/file`).blocked?.reason, 'private_network');
  for (const url of ['javascript:alert(1)', 'file:///C:/x.png', 'data:image/png;base64,AAAA']) { const d = c(url); assert.equal(d.blocked?.reason, 'dangerous_scheme', url); assert.equal(d.eetfAssetId, null); }
  assert.equal(c(`${API}/api/image/${ID}.png`).eetfAssetId, null, 'a Neurone image is not an EETF asset');
});

test('static audit: no HTML injection / eval, only Docteur routes, mixed KG files not imported for writing, no Notebook / KG / Professor / Agency', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const files = ['src/lib/eetf/bridges.ts', 'src/lib/eetf/integration-model.ts', 'src/components/eetf/EetfReaderPanel.tsx', 'src/components/eetf/EetfIntegrationPanel.tsx', 'src/components/eetf/EetfNeuronPicker.tsx'];
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML|\beval\(|new Function\(|document\.write|srcdoc|<iframe/, f);
    assert.doesNotMatch(text, /notebook|knowledge.?graph|\bkg[A-Z_]|professor|professeur|agency/i, `${f}: out-of-scope module`);
    assert.doesNotMatch(text, /['"`]https?:\/\/(?!127\.0\.0\.1)/, `${f}: no hard-coded remote URL`);
    assert.doesNotMatch(text, /localStorage|sessionStorage/, f);
  }
  const bridges = read('src/lib/eetf/bridges.ts');
  const fetchTargets = [...bridges.matchAll(/readOwnFile\(([^,)]+)/g)].map(m => m[1].trim()).filter(x => x !== 'url: string');
  assert.deepEqual(fetchTargets.sort(), ['cortexClient.mediaStudioAssetUrl(projectId', 'eetfAssetUrl(assetId', 'eetfAssetUrl(assetId'].sort(), 'bridges only read Docteur routes built from validated ids');
  assert.equal((bridges.match(/\bfetch\(/g) ?? []).length, 1, 'one fetch in the bridges (readOwnFile)');
  const reader = read('src/components/media/MediaReader.tsx');
  const code = reader.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /\/api\/(?!image|audio-player|files)/, 'Media Reader still calls no backend route of its own');
  const iframeSrcs = [...reader.matchAll(/<iframe[\s\S]*?src=\{([^}]+)\}/g)].map(m => m[1].trim());
  assert.deepEqual(iframeSrcs.sort(), ['descriptor.youtube?.embedUrl', 'objectUrl'].sort(), 'no new iframe');
  const block = read('src/components/blocks/Block.tsx');
  assert.match(block, /onUploadImage=\{onUploadImage\}/, 'Neurone insertion goes through the block\'s own onUploadImage');
});
