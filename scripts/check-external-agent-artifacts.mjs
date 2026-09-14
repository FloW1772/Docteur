import fs from 'node:fs';
import path from 'node:path';
const patterns = [/\bsk-(?:ant-|or-)?[A-Za-z0-9_-]{24,}\b/g, /\bgsk_[A-Za-z0-9_-]{24,}\b/g, /\bAIza[A-Za-z0-9_-]{30,}\b/g, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g];
let count = 0, files = 0;
function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.(?:js|json|html|css)$/.test(entry.name)) {
      files++; const text = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) count += [...text.matchAll(pattern)].length;
    }
  }
}
scan('dist');
console.log(JSON.stringify({scannedBundleFiles: files, recognizableSecretMatches: count}));
if (count) process.exitCode = 1;
