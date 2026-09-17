import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cwd = path.join(root, 'cortex-server');
const reports = path.join(root, 'reports');
const excluded = new Set(['test-setup.mjs', 'test-find-eval.mjs', 'test-regression-api.mjs', 'test-video-manual.mjs']);
const files = fs.readdirSync(cwd).filter(f => /^test-.*\.mjs$/.test(f) && !excluded.has(f)).sort();
const results = [];
for (const file of files) {
  const output = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-connectors-offline-guard.mjs')).href, '--experimental-test-module-mocks', '--test', '--test-timeout=120000', file],
      { cwd, shell: false, windowsHide: true, env: { ...process.env, DOCTEUR_TEST_MODE: '1' } });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => resolve({ code: 1, text: String(error) }));
    child.on('close', code => resolve({ code, text }));
  });
  fs.writeFileSync(path.join(reports, `certification-${file}.log`), output.text);
  const metric = name => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(output.text)?.[1] ?? 0);
  const result = { file, code: output.code, tests: metric('tests'), pass: metric('pass'), fail: metric('fail'), cancelled: metric('cancelled'), skipped: metric('skipped') };
  results.push(result);
  console.log(JSON.stringify(result));
}
const total = results.reduce((sum, r) => ({ tests: sum.tests + r.tests, pass: sum.pass + r.pass, fail: sum.fail + r.fail, cancelled: sum.cancelled + r.cancelled, skipped: sum.skipped + r.skipped }), { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0 });
fs.writeFileSync(path.join(reports, 'connectors-certification-results.json'), JSON.stringify({ results, total }, null, 2));
console.log('TOTAL', JSON.stringify(total));
process.exitCode = results.some(r => r.code !== 0 || r.fail || r.cancelled) ? 1 : 0;
