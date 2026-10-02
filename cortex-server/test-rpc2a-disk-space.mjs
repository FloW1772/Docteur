// ROOT POLICY V1 CLOSURE — RPC-2A: disk-space.js must never turn a caller-controlled folder into PowerShell source.
// NEGATIVE tests use an injected execFile (nothing is ever started with a hostile value); POSITIVE tests run the real
// Get-PSDrive on benign paths (Windows only) and prove the legitimate behaviour is unchanged.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFreeSpaceInvocation, driveNameFor, freeDiskSpaceBytes, DRIVE_ENV_VAR, FREE_SPACE_SCRIPT } from './src/lib/disk-space.js';

const B = String.fromCharCode(92);
const win = process.platform === 'win32';
const CONSTANT_ARGS = ['-NoProfile', '-NonInteractive', '-Command', FREE_SPACE_SCRIPT];

// A recorder that behaves like execFile but starts nothing.
const recorder = (stdout = '1234567') => {
  const calls = [];
  const impl = (file, args, options, cb) => { calls.push({ file, args: [...args], options }); cb(null, stdout); };
  return { calls, impl };
};

const HOSTILE = [
  `${B}${B}h${B}sh'; calc; '${B}z`,                       // the exact RPC-1 reproduction
  `${B}${B}h${B}sh"; calc; "${B}z`,
  `${B}${B}h${B}sh'); Start-Process calc; ('${B}z`,
  `${B}${B}h${B}sh' | Remove-Item -Recurse C:${B}x | '${B}z`,
  `${B}${B}h${B}sh' & calc & '${B}z`,
  `${B}${B}h${B}$(calc)${B}z`,
  `${B}${B}h${B}sh\`;calc${B}z`,
  `${B}${B}h${B}sh'${B}n;calc;${B}z`,
  `${B}${B}h${B}sh'; Invoke-Expression 'calc'; '${B}z`,
  `${B}${B}${'a'.repeat(5000)}'; calc; '${B}z`,
  `${B}${B}h'; calc; '${B}x'; cmd /c calc; '${B}z`,
];

test('NEGATIVE: the PowerShell command text is a constant — hostile folders never reach it', async () => {
  for (const hostile of HOSTILE) {
    const { calls, impl } = recorder();
    const result = await freeDiskSpaceBytes(hostile, { execFileImpl: impl });
    assert.equal(calls.length, 1, 'exactly one launch');
    const [{ file, args, options }] = calls;
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args, CONSTANT_ARGS, 'args are the constant list');
    // the hostile text appears nowhere in anything that PowerShell parses as code
    const code = args.join(' ');
    assert.ok(!/calc|Remove-Item|Invoke-Expression|Start-Process|cmd \/c/.test(code), `payload leaked into the command text: ${hostile.slice(0, 30)}`);
    assert.ok(!code.includes("'"), 'the command text has no quote to break out of');
    // it only travels as DATA, in the environment
    assert.equal(options.env[DRIVE_ENV_VAR], driveNameFor(hostile));
    assert.equal(typeof result, 'number');
  }
});

test('NEGATIVE: the command text contains no interpolation point and no quoted literal (static)', () => {
  assert.ok(FREE_SPACE_SCRIPT.includes(`Get-PSDrive -Name $env:${DRIVE_ENV_VAR}`), 'the name is read from the environment');
  assert.ok(!/['"`]/.test(FREE_SPACE_SCRIPT), 'no quote or backtick anywhere in the constant script');
  const src = fs.readFileSync(fileURLToPath(new URL('./src/lib/disk-space.js', import.meta.url)), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /Get-PSDrive -Name '/, 'the old quoted splice must be gone');
  assert.doesNotMatch(code, /`[^`]*\$\{(?!DRIVE_ENV_VAR)[^}]*\}[^`]*Get-PSDrive/, 'no template interpolation into the script');
});

test('NEGATIVE: values Windows cannot carry in an environment variable resolve to null, never throw', async () => {
  assert.equal(await freeDiskSpaceBytes(`${B}${B}h${B}sh\0re${B}z`), null);          // real execFile rejects the NUL synchronously, before any process exists
  assert.equal(await freeDiskSpaceBytes(`${B}${B}h${B}sh\0re${B}z`, { execFileImpl: () => { throw new Error('boom'); } }), null);
  assert.equal(await freeDiskSpaceBytes(undefined, { execFileImpl: recorder().impl }), null); // non-string input: unknown, not an exception
});

test('NEGATIVE: a launch error or garbage output is "unknown", exactly as before', async () => {
  assert.equal(await freeDiskSpaceBytes(`C:${B}x`, { execFileImpl: (f, a, o, cb) => cb(new Error('exit 1')) }), null);
  assert.equal(await freeDiskSpaceBytes(`C:${B}x`, { execFileImpl: recorder('not a number').impl }), null);
});

test('POSITIVE (pure): drive-name derivation is unchanged for every legitimate shape', () => {
  assert.equal(driveNameFor(`C:${B}`), 'C');
  assert.equal(driveNameFor(`C:${B}Users${B}x`), 'C');
  assert.equal(driveNameFor(`d:${B}zim`), 'd');
  assert.equal(driveNameFor(`C:${B}Program Files${B}Some App`), 'C');
  assert.equal(driveNameFor(`C:${B}Users${B}Zoë${B}été — 日本語`), 'C');
  assert.equal(driveNameFor('C:/forward/slashes'), 'C');
  assert.equal(driveNameFor(`${B}${B}srv${B}share${B}x`), 'srvshare');   // UNC: same derivation as before (looked up as a name, never run)
  assert.deepEqual(buildFreeSpaceInvocation('C'), { file: 'powershell.exe', args: CONSTANT_ARGS, env: { ...process.env, [DRIVE_ENV_VAR]: 'C' } });
  assert.equal(CONSTANT_ARGS.length, 4, 'same launch shape as before: no extra flag, no file, no stdin');
});

test('POSITIVE (pure): no new approval, no network, no extra process: one launch, same options', async () => {
  const { calls, impl } = recorder();
  await freeDiskSpaceBytes(`C:${B}x`, { execFileImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 8000, 'same timeout as before');
});

test('POSITIVE (real PowerShell): local drives, spaces, Unicode, long paths, relative paths all report real free space', { skip: !win, timeout: 60_000 }, async () => {
  const long = `C:${B}` + Array.from({ length: 30 }, (_, i) => `dossier_tres_long_${i}`).join(B);
  const cases = {
    'C root': `C:${B}`, 'C subfolder': `C:${B}Users`, 'spaces': `C:${B}Program Files${B}Some App${B}archives zim`,
    'unicode': `C:${B}Users${B}Zoë${B}Documents${B}été — 日本語${B}zim`, 'long (>260)': long, 'lowercase drive': `c:${B}temp`,
    'forward slashes': 'C:/Users/x', 'relative': 'zim-archives',
  };
  const values = {};
  for (const [name, p] of Object.entries(cases)) {
    const started = performance.now();
    const free = await freeDiskSpaceBytes(p);
    const ms = performance.now() - started;
    assert.equal(typeof free, 'number', `${name}: a number`);
    assert.ok(free > 0, `${name}: positive free space`);
    assert.ok(ms < 5000, `${name}: ${Math.round(ms)} ms is well inside the 8 s budget`);
    values[name] = free;
  }
  const c = values['C root'];
  for (const [name, v] of Object.entries(values)) if (name !== 'relative') assert.ok(Math.abs(v - c) < 200 * 1024 * 1024, `${name} reports the same C: drive`);
  if (fs.existsSync(`D:${B}`)) assert.ok((await freeDiskSpaceBytes(`D:${B}`)) > 0, 'D: reports its own free space');
});

test('POSITIVE (real PowerShell): quotes in a folder name are plain data — no parse error, no exception, "unknown" like any non-drive', { skip: !win, timeout: 30_000 }, async () => {
  // an apostrophe-only name (no code at all): it used to be a PowerShell parse error (→ null); it stays "unknown" (null)
  assert.equal(await freeDiskSpaceBytes(`${B}${B}ho'st${B}sh'are${B}x`), null);
});

test('POSITIVE (real PowerShell): a UNC share is "unknown" (null), never a false 0 that would refuse a download as "not enough space"', { skip: !win, timeout: 30_000 }, async () => {
  assert.equal(await freeDiskSpaceBytes(`${B}${B}fileserver${B}partage${B}zim`), null);
  assert.equal(await freeDiskSpaceBytes(`${B}${B}localhost${B}C$${B}Users`), null);
});
