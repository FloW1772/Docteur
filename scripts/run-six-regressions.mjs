import { spawn } from 'node:child_process';
const backend = spawn(process.execPath, ['cortex-server/test-regression-api.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture API startup timeout')), 15000);
    backend.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture API exited: ${code}`)); });
    backend.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timeout); resolve(); } });
  });
  for (const script of ['test-six-regressions', 'test-gesture-chain', 'test-startup-gate']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`scripts/${script}.mjs`], { stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed (${code})`)));
    });
  }
} finally { backend.kill(); }
