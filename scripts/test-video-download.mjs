import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const mediaSource = fs.readFileSync(new URL('../src/lib/media/media-resource.ts', import.meta.url), 'utf8');
const downloadSource = fs.readFileSync(new URL('../src/lib/media/video-download.ts', import.meta.url), 'utf8')
  .replace("import { classifyMediaResource, type MediaDescriptor } from './media-resource';", '');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(`${transpile(mediaSource)}\n${transpile(downloadSource)}`).toString('base64')}`);

test('offers native download for direct video files and sanitizes the filename', () => {
  const result = module.videoDownloadAvailability('https://cdn.example.test/media/My%20clip%3F.mp4?token=ignored');
  assert.equal(result.status, 'available');
  assert.equal(result.filename, 'My clip_.mp4');
});

for (const url of [
  'https://www.youtube.com/watch?v=abcdefghijk',
  'https://vimeo.com/123456',
  'https://www.dailymotion.com/video/x123456',
]) test(`refuses an external platform without a direct authorized file: ${url}`, () => {
  const result = module.videoDownloadAvailability(url);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Téléchargement non disponible/);
});

for (const url of [
  'javascript:alert(1)',
  'https://localhost/video.mp4',
  'https://user:password@example.test/video.mp4',
]) test(`blocks unsafe video URL: ${url}`, () => {
  const result = module.videoDownloadAvailability(url);
  assert.equal(result.status, 'blocked');
});

test('ignores non-video web links', () => {
  assert.equal(module.videoDownloadAvailability('https://example.test/article'), null);
});