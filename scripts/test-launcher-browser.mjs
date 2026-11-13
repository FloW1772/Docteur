// [STARTUP-3] Existing Docteur window reuse: pure selection logic, script privacy / safety, read-only real listing.
// No window is activated, closed or modified by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOCTEUR_TITLE, parseWindowRows, chooseDocteurWindow, findDocteurWindow, activateDocteurWindow } from './launcher-browser.mjs';
import { DOCTEUR_MARKER } from './wait-for-frontend.mjs';

test('the title looked for is exactly the Docteur page title (index.html, never changed at runtime)', () => {
  assert.equal(DOCTEUR_MARKER, `<title>${DOCTEUR_TITLE}</title>`);
  assert.match(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), new RegExp(`<title>${DOCTEUR_TITLE}</title>`));
});

test('rows: only well-formed app/tab rows survive; choice prefers a visible app window, then minimized, then a tab', () => {
  assert.deepEqual(parseWindowRows(['12|34|app|0', 'x|34|app|0', '12|y|app|0', '12|34|other|0', '12|34|app', null]), [{ hwnd: '12', pid: 34, kind: 'app', minimized: false }]);
  assert.deepEqual(parseWindowRows('5|6|tab|1'), [{ hwnd: '5', pid: 6, kind: 'tab', minimized: true }]);
  assert.deepEqual(parseWindowRows(null), []);
  const tab = { hwnd: '1', pid: 1, kind: 'tab', minimized: false };
  const appMin = { hwnd: '2', pid: 1, kind: 'app', minimized: true };
  const app = { hwnd: '3', pid: 1, kind: 'app', minimized: false };
  assert.equal(chooseDocteurWindow([tab, appMin, app]), app);
  assert.equal(chooseDocteurWindow([tab, appMin]), appMin);
  assert.equal(chooseDocteurWindow([tab]), tab);
  assert.equal(chooseDocteurWindow([]), null);
});

test('failures never pretend a window exists; invalid targets never reach PowerShell', async () => {
  const run = result => async () => result;
  assert.deepEqual(await findDocteurWindow({ platform: 'linux' }), { ok: false });
  assert.deepEqual(await findDocteurWindow({ platform: 'win32', run: run({ ok: false }) }), { ok: false });
  assert.deepEqual(await findDocteurWindow({ platform: 'win32', run: run({ ok: true, stdout: 'garbage' }) }), { ok: false });
  assert.deepEqual(await findDocteurWindow({ platform: 'win32', run: run({ ok: true, stdout: '{"ok":true,"windows":[]}' }) }), { ok: true, window: null });
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, stdout: '{"result":"activated"}' }; };
  for (const bad of [null, { hwnd: 'x', pid: 1 }, { hwnd: '1;calc', pid: 1 }, { hwnd: '1', pid: '1' }, { hwnd: '12345678901234567890', pid: 1 }]) {
    assert.equal(await activateDocteurWindow(bad, { platform: 'win32', run: counting }), 'failed');
  }
  assert.equal(calls, 0);
  assert.equal(await activateDocteurWindow({ hwnd: '1', pid: 2 }, { platform: 'win32', run: counting }), 'activated');
});

test('script safety: chrome.exe windows only, exact titles only, no closing / killing / debugging / profile access', () => {
  const src = fs.readFileSync(new URL('./launcher-browser.mjs', import.meta.url), 'utf8');
  assert.match(src, /Get-Process -Name chrome/);
  assert.match(src, /if \(wanted\.Contains\(t\)\) r\.Add/, 'a title is reported only when it is exactly a Docteur title');
  assert.match(src, /if \(p != pid \|\| Array\.IndexOf\(pids, p\) < 0 \|\| Array\.IndexOf\(titles, Title\(h\)\) < 0\) return "changed";/, 're-verified before activation');
  for (const forbidden of [/WM_CLOSE|0x0010|PostMessage|SendMessage|DestroyWindow|CloseWindow|EndTask/, /TerminateProcess|Stop-Process|taskkill|\.Kill\(/, /remote-debugging|--user-data-dir|User Data|Preferences/i]) {
    assert.doesNotMatch(src.replace(/^\/\/.*$/gm, ''), forbidden);
  }
});

test('real, read-only listing: answers, reports no foreign title', { skip: process.platform !== 'win32' }, async () => {
  const r = await findDocteurWindow();
  assert.equal(r.ok, true);
  if (r.window) assert.deepEqual(Object.keys(r.window).sort(), ['hwnd', 'kind', 'minimized', 'pid'], 'handle / pid / kind only — no title text');
});
