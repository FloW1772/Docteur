// Explicit operator action only. Never called by a request or at startup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RUNTIME_ROOT, childEnvironment, verifySource } from '../cortex-server/src/lib/sherlock-policy.js';
verifySource();
if (fs.existsSync(RUNTIME_ROOT)) throw new Error('Sherlock runtime already exists; inspect it before any update.');
fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
const env = childEnvironment(path.join(RUNTIME_ROOT, 'setup-home'));
const run = (binary, args) => {
  const r = spawnSync(binary, args, { cwd: RUNTIME_ROOT, env, shell: false, windowsHide: true, stdio: 'inherit', timeout: 240000 });
  if (r.error || r.status !== 0) throw new Error(`Sherlock setup step failed: ${r.error?.code || r.status}`);
};
run('C:\\Program Files\\Python310\\python.exe', ['-I', '-m', 'venv', path.join(RUNTIME_ROOT, 'venv')]);
const python = path.join(RUNTIME_ROOT, 'venv/Scripts/python.exe');
const wheels = path.join(RUNTIME_ROOT, 'wheels'); fs.mkdirSync(wheels);
const pin = JSON.parse(fs.readFileSync(new URL('../cortex-server/src/lib/sherlock-pin.json', import.meta.url), 'utf8'));
const requirements = path.join(RUNTIME_ROOT, 'requirements.lock');
fs.writeFileSync(requirements, pin.dependencies.map(wheel => {
  const [name, version] = wheel.name.split('-');
  return `${name}==${version} --hash=sha256:${wheel.sha256}`;
}).join('\n') + '\n');
run(python, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'download', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--dest', wheels,
  '--require-hashes', '--no-deps', '-r', requirements]);
const wheelFiles = fs.readdirSync(wheels).filter(f => f.endsWith('.whl')).sort();
const lock = wheelFiles.map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(wheels, name))).digest('hex') }));
if (JSON.stringify(lock) !== JSON.stringify(pin.dependencies)) throw new Error('Downloaded wheels differ from audited dependency lock.');
fs.writeFileSync(path.join(RUNTIME_ROOT, 'dependency-lock.json'), JSON.stringify(lock, null, 2), { flag: 'wx' });
// Offline installation: no sdist build, no hooks, no dependency resolution.
run(python, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-index', '--no-deps', ...wheelFiles.map(f => path.join(wheels, f))]);
run(python, ['-I', '-m', 'pip', '--isolated', 'check']);
console.log('Dedicated Sherlock environment installed; source CLI was not executed.');
