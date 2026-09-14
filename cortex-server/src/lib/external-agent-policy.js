import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './logger.js';

export const CAPABILITY = 'external_code_agent';
export const FEATURES = ['code_analysis', 'code_generation', 'code_fix', 'refactor', 'debug', 'test_generation', 'repository_analysis'];
const ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']);
export function filteredEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => ENV_KEYS.has(key.toUpperCase())));
}
export function sanitize(value) {
  return redactSecrets(String(value ?? ''))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/((?:authorization|set-cookie|cookie)\s*["']?\s*[:=])[^\r\n]*/gi, '$1 [REDACTED]')
    .replace(/((?:[\w-]*(?:token|secret|password)|api[_-]?key)\s*["']?\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?:[\w-]*(?:token|secret|password)|api[_-]?key)\s*["']?\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]');
}
export function policyError(code) { return Object.assign(new Error(code), { code }); }
export function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
const BLOCKED = /^(?:\..*|node_modules|data|dist|certs|appdata|credentials?|secrets?|id_rsa|id_ed25519|agents\.md|claude\.md|skill\.md)$/i;
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.txt', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cs', '.vue', '.svelte', '.sql', '.yaml', '.yml', '.toml']);
export function safeRelative(name) {
  if (typeof name !== 'string' || name.length > 240 || /[\x00-\x1f:*?"<>|]/.test(name) || path.isAbsolute(name)) throw policyError('path_denied');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '..' || /[. ]$/.test(p) || BLOCKED.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw policyError('path_denied');
  if (!EXTENSIONS.has(path.extname(name).toLowerCase()) || /(?:auth|credential|secret|token|cookie|password|private[-_]?key)/i.test(path.basename(name))) throw policyError('sensitive_path');
  return parts.join('/');
}
export function checkedPath(root, name, allowMissing = false) {
  const relative = safeRelative(name);
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw policyError('path_denied');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      // lstat catches dangling links too.
      try { fs.lstatSync(current); throw policyError('symlink_denied'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (allowMissing) continue;
      throw policyError('file_missing');
    }
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !within(root, fs.realpathSync(current)) || (st.isFile() && st.nlink > 1)) throw policyError('symlink_denied');
  }
  return target;
}
export function authorizeRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw policyError('workspace_required');
  const root = fs.realpathSync(candidate);
  const home = os.homedir();
  if (!fs.statSync(root).isDirectory() || root === path.parse(root).root || within(root, home) || /(?:^|[\\/])(?:AppData|\.ssh|\.aws|\.config|\.codex|\.claude|\.agents|\.git|data|certs|node_modules)(?:[\\/]|$)/i.test(root)) throw policyError('workspace_denied');
  return root;
}
export function validateTask(input, roots) {
  if (!['auto', 'codex', 'claude'].includes(input.provider)) throw policyError('provider_invalid');
  if (!FEATURES.includes(input.feature)) throw policyError('feature_incompatible');
  if (!['SAFE', 'EDIT'].includes(input.permissions ?? 'SAFE') || !['read', 'edit'].includes(input.mode ?? 'read')) throw policyError('mode_unsupported');
  if ((input.permissions ?? 'SAFE') !== ((input.mode ?? 'read') === 'read' ? 'SAFE' : 'EDIT')) throw policyError('mode_invalid');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw policyError('prompt_invalid');
  if (sanitize(input.prompt) !== input.prompt || /(?:\.ssh|\.aws|\.codex|\.claude|auth\.json|credentials|cookies?\s*(?:browser|navigateur))/i.test(input.prompt)) throw policyError('secret_or_credentials_denied');
  if (/\b(?:rm\s+-[a-z]*r|rmdir\s+\/s|Remove-Item|format\s+[a-z]:|sudo|runas|reg\s+(?:add|delete)|shutdown|git\s+(?:push|reset|clean|commit|merge|rebase|checkout|switch)|git\s+branch\s+-[dD]|npm\s+(?:publish|install\s+-g)|deploy)\b/i.test(input.prompt)) throw policyError('dangerous_action_denied');
  const cwd = authorizeRoot(input.cwd);
  if (!roots.includes(cwd)) throw policyError('workspace_not_authorized');
  const timeout = input.timeout ?? 300000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000) throw policyError('timeout_invalid');
  if (input.model && (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(input.model))) throw policyError('model_invalid');
  if (!Array.isArray(input.files) || input.files.length > 100) throw policyError('files_invalid');
  const files = [...new Set(input.files.map(safeRelative))];
  return { provider: input.provider, feature: input.feature, prompt: input.prompt, cwd, timeout, permissions: input.permissions ?? 'SAFE', mode: input.mode ?? 'read', model: input.model || '', files };
}
