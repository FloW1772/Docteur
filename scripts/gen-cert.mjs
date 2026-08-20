import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, '..', 'certs');

if (existsSync(join(certsDir, 'key.pem')) && existsSync(join(certsDir, 'cert.pem'))) {
  console.log('Certs already exist in certs/ — skipping generation.');
  process.exit(0);
}

const pem = await getCertificate(join(homedir(), '.vite', 'basic-ssl'));
const keyMatch = pem.match(/-----BEGIN RSA PRIVATE KEY-----[\s\S]+?-----END RSA PRIVATE KEY-----/);
const certChain = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map(m => m[0]);

if (!keyMatch || certChain.length === 0) {
  console.error('Failed to extract key/cert from PEM.');
  process.exit(1);
}

mkdirSync(certsDir, { recursive: true });
writeFileSync(join(certsDir, 'key.pem'), keyMatch[0]);
writeFileSync(join(certsDir, 'cert.pem'), certChain.join('\n'));
console.log('Generated self-signed cert in certs/');
