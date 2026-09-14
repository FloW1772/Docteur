import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { authorizeRoot, checkedPath, safeRelative, validateTask, sanitize, within, policyError, CAPABILITY, FEATURES } from './external-agent-policy.js';
import { resolveCli, launchProcess, commandArgs } from './external-agent-process.js';

const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled']);
const MAX_BYTES = 2 * 1024 * 1024;
const publicCopy = value => JSON.parse(JSON.stringify(value));
export function classifyFailure(text) {
  if (/not logged|authentication.required|unauthorized|login required|please.*log.in/i.test(text)) return 'authentication_required';
  if (/quota|usage.limit|rate.limit|too many requests/i.test(text)) return 'quota_exhausted';
  if (/unknown (?:option|argument)|unexpected argument|unrecognized|unsupported/i.test(text)) return 'unsupported_version';
  return 'error';
}
function safeRead(root, relative) {
  const target = checkedPath(root, relative);
  const info = fs.statSync(target);
  if (!info.isFile() || info.size > 256 * 1024) throw policyError('file_too_large');
  const data = fs.readFileSync(target);
  const text = data.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(data)) throw policyError('binary_file_denied');
  if (sanitize(text) !== text) throw policyError('file_contains_secret');
  return text;
}

export class ExternalAgents extends EventEmitter {
  constructor({ projectRoot, dataDir, strictLocal = () => false, resolve = resolveCli, launch = launchProcess } = {}) {
    super();
    this.roots = [authorizeRoot(projectRoot)];
    this.dataDir = dataDir;
    this.strictLocal = strictLocal;
    this.resolve = resolve; this.launch = launch;
    this.jobs = new Map(); this.private = new Map(); this.rootRequests = new Map();
    this.closed = false;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.historyFile = path.join(dataDir, 'history.json');
      try {
        const records = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        if (Array.isArray(records)) for (const record of records.slice(-100)) {
          if (!record.id || !TERMINAL.has(record.status)) continue;
          // History is display-only: no executable, prompt, snapshot or auth state is restored.
          const safe = JSON.parse(sanitize(JSON.stringify(record)));
          safe.review = 'unavailable_after_restart';
          this.jobs.set(safe.id, safe);
        }
      } catch { /* Missing/corrupt history cannot enable execution. */ }
    }
  }
  checkCloud() { if (this.closed) throw policyError('service_closed'); if (this.strictLocal()) throw policyError('strict_local'); }
  settings() { return { capability: CAPABILITY, features: FEATURES, allowedRoots: [...this.roots], strictLocal: !!this.strictLocal(), maxTimeout: 1800000, modes: ['read', 'edit'], fallback: 'ask', limitations: ['Shell, build/test et FULL indisponibles : commandes non exécutées.', 'Seuls les fichiers sélectionnés sont copiés dans un workspace temporaire.', 'Les changements en attente sont perdus au redémarrage.'] }; }
  requestRoot(candidate) {
    for (const [id, request] of this.rootRequests) if (request.expires < Date.now()) this.rootRequests.delete(id);
    if (this.rootRequests.size >= 20) throw policyError('too_many_approvals');
    const root = authorizeRoot(candidate);
    const id = crypto.randomUUID();
    this.rootRequests.set(id, { root, expires: Date.now() + 300000 });
    return { id, root, message: 'Autoriser ce dossier pour la sélection explicite de fichiers ?' };
  }
  approveRoot(id, accepted) {
    const request = this.rootRequests.get(id); this.rootRequests.delete(id);
    if (!request || request.expires < Date.now()) throw policyError('approval_expired');
    if (accepted && authorizeRoot(request.root) === request.root && !this.roots.includes(request.root)) this.roots.push(request.root);
    return this.settings();
  }
  async probe(provider) {
    const executable = this.resolve(provider);
    if (!executable) return { installed: false, ready: false, reason: 'not_installed', version: null };
    const run = async args => {
      let output = '';
      const proc = this.launch({ executable, args, cwd: os.tmpdir(), timeout: 10000, onLine: (_stream, line) => { if (output.length < 65536) output += line + '\n'; } });
      return { ...(await proc.done), output };
    };
    const version = await run(['--version']);
    const number = version.output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
    const result = { installed: true, version: number, ready: false, reason: 'error' };
    if (version.reason === 'timeout') return { ...result, reason: 'timeout' };
    if (version.exitCode !== 0 || !number) return result;
    const help = await run(provider === 'codex' ? ['exec', '--help'] : ['--help']);
    const flags = provider === 'codex' ? ['--ignore-user-config', '--ephemeral', '--json'] : ['--restricted', '--safe-mode', '--tools', '--no-session-persistence'];
    if (help.reason === 'timeout') return { ...result, reason: 'timeout' };
    if (help.exitCode !== 0 || flags.some(flag => !help.output.includes(flag))) return { ...result, reason: 'unsupported_version' };
    // Conservative floors for the permission profiles / restricted mode retained here.
    const parts = number.split('.').map(Number);
    const minimum = provider === 'codex' ? [0, 153, 4] : [2, 1, 248];
    if (parts[0] * 1000000 + parts[1] * 1000 + parts[2] < minimum[0] * 1000000 + minimum[1] * 1000 + minimum[2]) return { ...result, reason: 'unsupported_version' };
    // Discard auth command output entirely. Only its documented exit status matters.
    const auth = this.launch({ executable, args: provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], cwd: os.tmpdir(), timeout: 10000 });
    const status = await auth.done;
    return { ...result, ready: status.exitCode === 0 && !status.reason, reason: status.reason === 'timeout' ? 'timeout' : status.exitCode === 0 ? 'ready' : status.exitCode === 1 ? 'authentication_required' : 'error' };
  }
  async detect() {
    const [codex, claude] = await Promise.all([this.probe('codex'), this.probe('claude')]);
    return { codex, claude };
  }
  list() { return [...this.jobs.values()].reverse().map(publicCopy); }
  get(id) { const job = this.jobs.get(id); if (!job) throw policyError('job_missing'); return publicCopy(job); }
  publish(job) { this.emit('job', publicCopy(job)); }
  persist() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= 100) break;
      if (TERMINAL.has(job.status) && !['pending', 'cleanup_required'].includes(job.review)) { this.release(id); this.jobs.delete(id); }
    }
    if (!this.historyFile) return;
    const records = [...this.jobs.values()].filter(j => TERMINAL.has(j.status)).slice(-100);
    const temporary = `${this.historyFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(records));
    fs.renameSync(temporary, this.historyFile);
  }
  preview(input) {
    this.checkCloud();
    const task = validateTask(input, this.roots);
    const snapshot = new Map(); let bytes = 0;
    for (const file of task.files) {
      const text = safeRead(task.cwd, file); bytes += Buffer.byteLength(text);
      if (bytes > MAX_BYTES) throw policyError('context_too_large');
      snapshot.set(file, text);
    }
    if (this.private.size >= 20) throw policyError('too_many_jobs');
    const id = crypto.randomUUID();
    const job = { id, capability: CAPABILITY, provider: task.provider, feature: task.feature, task: `${task.feature} · ${task.files.length} fichier(s)`, workspace: task.cwd, permissions: task.permissions, mode: task.mode, status: 'waiting_approval', created_at: new Date().toISOString(), started_at: null, finished_at: null, exit_code: null, duration: 0, output: '', error: null, changes: [], review: 'none', scope: { prompt: sanitize(task.prompt), files: task.files, bytes, service: task.provider, privateNeurons: false }, tests: 'Aucune commande de test exécutée.' };
    this.jobs.set(id, job); this.private.set(id, { task, snapshot, expires: Date.now() + 300000 });
    this.publish(job);
    return publicCopy(job);
  }
  async approve(id, accepted) {
    const job = this.jobs.get(id), internal = this.private.get(id);
    if (!job || !internal || job.status !== 'waiting_approval') throw policyError('approval_invalid');
    if (!accepted) { this.finish(job, 'cancelled', null); return this.get(id); }
    this.checkCloud();
    if (internal.expires < Date.now()) throw policyError('approval_expired');
    // Approval is tied to the exact preview; stale source content requires a new one.
    for (const [file, text] of internal.snapshot) if (safeRead(internal.task.cwd, file) !== text) throw policyError('context_changed');
    job.status = 'queued'; delete job.scope.prompt; this.publish(job);
    this.drain(); return this.get(id);
  }
  drain() {
    if (this.closed) return;
    const active = [...this.jobs.values()].filter(j => ['starting', 'running'].includes(j.status));
    if (active.length >= 2) return;
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued') continue;
      const conflict = [...this.jobs.values()].some(other => other.id !== job.id && other.permissions === 'EDIT' && (['starting', 'running'].includes(other.status) || ['pending', 'cleanup_required'].includes(other.review)) && (within(other.workspace, job.workspace) || within(job.workspace, other.workspace)));
      if (job.permissions === 'EDIT' && conflict) continue;
      job.status = 'starting'; this.publish(job);
      void this.execute(job).catch(() => this.finish(job, 'failed', null, 'error'));
      if (++active.length >= 2) break;
    }
  }
  async execute(job) {
    const internal = this.private.get(job.id);
    this.checkCloud();
    const { task, snapshot } = internal;
    // A queued task must still reference the content explicitly approved.
    for (const [file, text] of snapshot) if (safeRead(task.cwd, file) !== text) throw policyError('context_changed');
    let provider = task.provider;
    if (provider === 'auto') {
      const clients = await this.detect();
      provider = clients.codex.ready ? 'codex' : clients.claude.ready ? 'claude' : null;
      if (!provider) { this.finish(job, 'failed', null, 'no_agent_ready'); return; }
    }
    const state = await this.probe(provider);
    if (job.status !== 'starting') return;
    this.checkCloud();
    if (!state.ready) { this.finish(job, 'failed', null, state.reason); return; }
    job.provider = provider;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-agent-'));
    internal.stage = fs.realpathSync(stage);
    for (const [file, text] of snapshot) {
      const target = checkedPath(internal.stage, file, true);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text, { flag: 'wx' });
    }
    job.status = 'running'; job.started_at = new Date().toISOString();
    this.publish(job);
    const args = commandArgs(provider, { ...task, cwd: internal.stage });
    // Codex has no shell tool in this profile; selected context is passed explicitly.
    const context = provider === 'codex' ? [...snapshot].map(([file, text]) => `\nFILE ${file}\n${text}`).join('\n') : '';
    const prompt = `Tâche de code dans le workspace temporaire ${internal.stage}. Profil ${task.permissions}. Aucun accès hors workspace, secret, shell, réseau, Git en écriture, publication ou déploiement. ${task.permissions === 'SAFE' ? 'Analyse uniquement, aucune écriture.' : 'Prépare les changements uniquement dans ce workspace temporaire.'}\n${task.prompt}\nFichiers autorisés: ${task.files.join(', ')}\n${context}`;
    internal.process = this.launch({ executable: this.resolve(provider), args, cwd: internal.stage, input: prompt, timeout: task.timeout, onLine: (stream, line) => {
      if (job.output.length < 256000) job.output += `[${stream}] ${line}\n`;
      // JSON parsing is best effort on already scrubbed events. No raw event retained.
      try {
        const event = JSON.parse(line);
        const summary = event.type === 'result' ? event.result : event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : null;
        if (typeof summary === 'string') job.summary = sanitize(summary).slice(0, 8000);
        if (event.type === 'result' && event.is_error || event.type === 'turn.failed' || event.type === 'error') internal.failure = classifyFailure(line);
        if (event.type === 'result' && event.permission_denials?.length) internal.failure = 'permission_denied';
      } catch {}
      this.publish(job);
    } });
    const result = await internal.process.done;
    internal.process = null;
    if (result.cleanupConfirmed === false) {
      internal.cleanupUnconfirmed = true; job.review = 'cleanup_required';
      this.finish(job, 'failed', result.exitCode, 'cleanup_unconfirmed'); return;
    }
    if (result.reason === 'timeout' || result.reason === 'cancelled') { this.finish(job, result.reason, result.exitCode); return; }
    if (result.exitCode !== 0 || result.reason || internal.failure) { this.finish(job, 'failed', result.exitCode, internal.failure ?? classifyFailure(job.output)); return; }
    try {
      internal.after = this.readStage(internal.stage);
      const names = new Set([...snapshot.keys(), ...internal.after.keys()]);
      const changes = [];
      for (const file of names) {
        const before = snapshot.get(file), after = internal.after.get(file);
        if (before === after) continue;
        changes.push({ path: file, kind: before === undefined ? 'created' : after === undefined ? 'deleted' : 'modified', diff: `--- ${file}\n+++ ${file}\n${(before ?? '').split('\n').map(l => `-${l}`).join('\n')}\n${(after ?? '').split('\n').map(l => `+${l}`).join('\n')}` });
      }
      if (job.permissions === 'SAFE' && changes.length) throw policyError('read_only_violation');
      job.changes = changes;
      job.review = changes.length ? 'pending' : 'none';
      this.finish(job, 'completed', result.exitCode);
    } catch (e) { this.finish(job, 'failed', result.exitCode, e.code === 'read_only_violation' ? e.code : 'unsafe_output'); }
  }
  readStage(root) {
    const result = new Map(); let bytes = 0;
    const walk = relative => {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw policyError('symlink_denied');
        if (entry.isDirectory()) {
          // Validate directory using a harmless hypothetical source filename.
          checkedPath(root, `${file}/check.txt`, true); walk(file);
        } else {
          const text = safeRead(root, file); bytes += Buffer.byteLength(text);
          if (bytes > MAX_BYTES || result.size >= 100) throw policyError('output_too_large');
          result.set(file, text);
        }
      }
    };
    walk(''); return result;
  }
  finish(job, status, exitCode, error = null) {
    if (TERMINAL.has(job.status)) return;
    job.status = status; job.exit_code = exitCode; job.error = error;
    job.finished_at = new Date().toISOString();
    job.duration = job.started_at ? Date.now() - Date.parse(job.started_at) : 0;
    delete job.scope.prompt;
    const internal = this.private.get(job.id);
    if (internal) { delete internal.task.prompt; if (!['pending', 'cleanup_required'].includes(job.review)) this.release(job.id); }
    this.publish(job); this.persist(); this.drain();
  }
  cancel(id) {
    const job = this.jobs.get(id); if (!job) throw policyError('job_missing');
    if (TERMINAL.has(job.status)) return this.get(id);
    const internal = this.private.get(id);
    if (internal?.process) internal.process.stop('cancelled');
    else this.finish(job, 'cancelled', null);
    return this.get(id);
  }
  review(id, accept) {
    const job = this.jobs.get(id), internal = this.private.get(id);
    if (!job || job.review !== 'pending' || !internal?.after) throw policyError('review_unavailable');
    if (accept) {
      const root = authorizeRoot(job.workspace);
      if (!this.roots.includes(root) || root !== job.workspace) throw policyError('workspace_not_authorized');
      // Validate every path and baseline BEFORE touching any file. No git reset/clean.
      const operations = job.changes.map(change => {
        const target = checkedPath(root, change.path, true);
        const baseline = internal.snapshot.get(change.path);
        const current = fs.existsSync(target) ? safeRead(root, change.path) : undefined;
        if (current !== baseline) throw policyError('review_conflict');
        return { target, before: baseline, after: internal.after.get(change.path) };
      });
      const applied = [];
      try {
        for (const op of operations) {
          fs.mkdirSync(path.dirname(op.target), { recursive: true });
          if (op.after === undefined) fs.unlinkSync(op.target); else fs.writeFileSync(op.target, op.after);
          applied.push(op);
        }
      } catch (error) {
        for (const op of applied.reverse()) {
          if (op.before === undefined) fs.unlinkSync(op.target); else fs.writeFileSync(op.target, op.before);
        }
        throw policyError('apply_failed');
      }
      // Keep a compare-and-swap baseline for an explicit undo in this session.
      internal.applied = true; job.review = 'accepted';
    } else { job.review = 'rejected'; this.release(id); }
    this.publish(job); this.persist(); this.drain(); return this.get(id);
  }
  undo(id) {
    const job = this.jobs.get(id), internal = this.private.get(id);
    if (!internal?.applied || job?.review !== 'accepted') throw policyError('undo_unavailable');
    // Reverse snapshots and reuse all conflict / path validation in review().
    const before = internal.snapshot; internal.snapshot = internal.after; internal.after = before;
    job.review = 'pending';
    try { this.review(id, true); job.review = 'reverted'; this.release(id); this.persist(); this.publish(job); return this.get(id); }
    catch (e) { internal.after = internal.snapshot; internal.snapshot = before; job.review = 'accepted'; throw e; }
  }
  release(id) {
    const internal = this.private.get(id);
    if (internal?.cleanupUnconfirmed) return;
    if (internal?.stage) {
      const stage = internal.stage;
      // Only delete the exact mkdtemp directory directly under the resolved temp root.
      if (path.dirname(stage) === fs.realpathSync(os.tmpdir()) && path.basename(stage).startsWith('docteur-agent-') && !fs.lstatSync(stage).isSymbolicLink()) fs.rmSync(stage, { recursive: true, force: true });
    }
    this.private.delete(id);
  }
  deleteHistory() {
    for (const [id, job] of this.jobs) if (TERMINAL.has(job.status) && !['pending', 'cleanup_required'].includes(job.review)) { this.release(id); this.jobs.delete(id); }
    this.persist(); return this.list();
  }
  async shutdown() {
    this.closed = true;
    const running = [];
    for (const [id, internal] of this.private) {
      if (internal.process) { running.push(internal.process.done); internal.process.stop('cancelled'); }
      else if (!TERMINAL.has(this.jobs.get(id).status)) this.finish(this.jobs.get(id), 'cancelled', null);
    }
    await Promise.all(running);
    for (const id of this.private.keys()) this.release(id);
  }
}

export function runExternalAgent(service, input) { return service.preview(input); }
