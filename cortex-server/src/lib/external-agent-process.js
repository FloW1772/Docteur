import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { filteredEnv, sanitize, policyError } from './external-agent-policy.js';

// Resolve only executables / official npm entrypoints, never execute a .cmd/.ps1 shim.
export function resolveCli(provider, env = filteredEnv(), platform = process.platform) {
  if (!['codex', 'claude'].includes(provider)) throw policyError('provider_invalid');
  const dirs = (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    const executable = path.join(dir, provider + (platform === 'win32' ? '.exe' : ''));
    try { if (fs.statSync(executable).isFile()) return { command: fs.realpathSync(executable), prefix: [] }; } catch {}
    if (platform === 'win32') {
      const entry = path.join(dir, 'node_modules', provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
      try { if (fs.statSync(entry).isFile()) return { command: process.execPath, prefix: [fs.realpathSync(entry)] }; } catch {}
    }
  }
  return null;
}

// Complete lines are scrubbed before crossing the callback boundary. Never emit
// fragments: a credential may span arbitrary stdout chunks. Overlong lines drop.
export function lineSink(emit) {
  const decoder = new StringDecoder('utf8');
  let pending = '', dropping = false, pem = false;
  function line(value) {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(value)) pem = true;
    if (pem) {
      if (/-----END .*PRIVATE KEY-----/.test(value)) pem = false;
      emit('[REDACTED PRIVATE KEY]');
    } else emit(sanitize(value));
  }
  function consume(text) {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const end = part.endsWith('\n');
      if (!dropping) pending += part;
      if (pending.length > 65536) { pending = ''; dropping = true; }
      if (end) {
        if (dropping) emit('[OUTPUT LINE OMITTED: size limit]'); else line(pending.trimEnd());
        pending = ''; dropping = false;
      }
    }
  }
  return { write: chunk => consume(decoder.write(chunk)), end() { consume(decoder.end()); if (pending && !dropping) line(pending); pending = ''; } };
}

export function launchProcess({ executable, args, cwd, input = '', timeout = 300000, onLine = () => {}, spawnImpl = spawn, env = filteredEnv(), graceMs = 1000 }) {
  let child, stopped = null, forced, timer, stopDeadline;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let settled = false;
  const finish = (exitCode, error, cleanupConfirmed = true) => {
    if (settled) return;
    settled = true; clearTimeout(timer); clearTimeout(stopDeadline);
    if (stopped && process.platform !== 'win32') killTree(true);
    // A forced Windows tree sweep has already been requested by stop().
    clearTimeout(forced);
    out.end(); err.end();
    resolveDone({ exitCode, reason: cleanupConfirmed ? stopped ?? (error ? 'error' : null) : 'cleanup_unconfirmed', cleanupConfirmed });
  };
  const out = lineSink(line => onLine('stdout', line));
  const err = lineSink(line => onLine('stderr', line));
  function killTree(force) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { shell: false, windowsHide: true, env, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch {} });
      killer.on('exit', code => { if (code !== 0 && force) { try { child.kill(); } catch {} } });
    } else {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
    }
  }
  function stop(reason = 'cancelled') {
    if (settled || stopped) return;
    stopped = reason;
    // taskkill /T /F is required for Windows console processes. An initial
    // non-forced tree termination is attempted; the force request is issued
    // immediately on Windows so a parent exiting cannot hide its descendants.
    killTree(false);
    if (process.platform === 'win32') killTree(true);
    else forced = setTimeout(() => killTree(true), graceMs);
    stopDeadline = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      child.stdout?.destroy(); child.stderr?.destroy();
      child.unref();
      finish(null, true, false);
    }, 5000);
  }
  try {
    child = spawnImpl(executable.command, [...executable.prefix, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => out.write(chunk));
    child.stderr.on('data', chunk => err.write(chunk));
    child.once('error', () => finish(null, true));
    child.once('close', code => finish(code, false));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => stop('timeout'), timeout);
  } catch { finish(null, true); }
  return { done, stop, get pid() { return child?.pid; } };
}

export function commandArgs(provider, { cwd, permissions = 'SAFE', model = '' }) {
  if (provider === 'claude') {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--restricted', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', permissions === 'SAFE' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write', '--disallowedTools', 'Bash,PowerShell,Agent,WebFetch,WebSearch,mcp__*', '--permission-mode', permissions === 'SAFE' ? 'default' : 'acceptEdits', ...(model ? ['--model', model] : [])];
  }
  // Named profile avoids the broad filesystem reads of legacy read-only mode.
  // No extends: only the staged directory is available to sandboxed tools.
  const config = [
    'default_permissions="docteur"',
    `permissions.docteur.filesystem={${JSON.stringify(cwd)}=${JSON.stringify(permissions === 'SAFE' ? 'read' : 'write')}}`,
    'permissions.docteur.network.enabled=false', 'approval_policy="never"',
    'features.shell_tool=false', 'features.unified_exec=false', 'features.shell_snapshot=false',
    'features.apps=false', 'apps._default.enabled=false', 'features.multi_agent=false',
    'features.hooks=false', 'features.memories=false', 'features.remote_plugin=false',
    'features.skill_mcp_dependency_install=false', 'web_search="disabled"', 'tools.view_image=false',
    'shell_environment_policy.inherit="none"',
  ];
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '-C', cwd, ...config.flatMap(value => ['-c', value]), ...(model ? ['--model', model] : []), '-'];
}
