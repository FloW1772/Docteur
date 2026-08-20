/**
 * Inbox watcher — importe les fichiers déposés dans un dossier surveillé.
 *
 * Sécurité :
 * - Pas d'endpoint réseau : lecture locale du système de fichiers uniquement
 * - Liens symboliques ignorés (lstat + realpathSync)
 * - Remontée via ../ bloquée (vérification realpath vs base)
 * - Contenu traité comme données, jamais comme instructions
 * - 2 Mo max par fichier, 20 fichiers max par cycle
 * - Contenu importé jamais renvoyé automatiquement au cloud
 *
 * HOW TO EXTEND: add support for new extensions in SUPPORTED_EXTS.
 */

import crypto  from 'node:crypto';
import fs      from 'node:fs';
import path    from 'node:path';
import { getMeta, setMeta, insertInboxPending } from './sqlite.js';

const MAX_FILE_BYTES    = 2 * 1024 * 1024; // 2 MB
const MAX_FILES_PER_RUN = 20;
const SUPPORTED_EXTS    = new Set(['.md', '.txt', '.json']);

const FREQUENCY_MS = {
  hourly: 60 * 60 * 1000,
  daily:  24 * 60 * 60 * 1000,
};

// ── Settings ──────────────────────────────────────────────────────────────────

export function getInboxSettings(defaultDir) {
  try {
    const raw = getMeta('inbox_settings');
    const s   = raw ? JSON.parse(raw) : {};
    return {
      enabled:    s.enabled    ?? false,
      inbox_dir:  s.inbox_dir  ?? defaultDir,
      frequency:  s.frequency  ?? 'daily',
      last_check: s.last_check ?? null,
    };
  } catch {
    return { enabled: false, inbox_dir: defaultDir, frequency: 'daily', last_check: null };
  }
}

export function updateInboxSettings(updates, defaultDir) {
  const current = getInboxSettings(defaultDir);
  const merged  = { ...current, ...updates };
  // Sanitize frequency
  if (!['hourly', 'daily', 'manual'].includes(merged.frequency)) merged.frequency = 'daily';
  setMeta('inbox_settings', JSON.stringify(merged));
  return merged;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTitle(content, filename) {
  const m = content.match(/^#\s+(.+)$/m);
  if (m?.[1]?.trim()) return m[1].trim().slice(0, 200);
  const first = content.split('\n').find(l => l.trim());
  if (first && first.length <= 120) return first.trim().slice(0, 200);
  return path.basename(filename, path.extname(filename));
}

function moveFile(src, destDir, filename) {
  const dest = path.join(destDir, filename);
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function writeErrorLog(errorsDir, filename, reason) {
  const msg = `[${new Date().toISOString()}] Erreur import — ${filename}\n\n${reason}\n`;
  try { fs.writeFileSync(path.join(errorsDir, `${filename}.log`), msg, 'utf8'); } catch { /* non-fatal */ }
}

// ── Core check ────────────────────────────────────────────────────────────────

export async function runInboxCheck({ inboxDir, logger } = {}) {
  const processedDir = path.join(inboxDir, 'traites');
  const errorsDir    = path.join(inboxDir, 'erreurs');

  try {
    fs.mkdirSync(processedDir, { recursive: true });
    fs.mkdirSync(errorsDir,    { recursive: true });
  } catch (err) {
    logger?.warn({ err: err.message }, 'inbox: cannot create sub-dirs');
    return { processed: 0, errors: 0, titles: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(inboxDir, { withFileTypes: true });
  } catch (err) {
    logger?.warn({ err: err.message }, 'inbox: cannot read inbox dir');
    return { processed: 0, errors: 0, titles: [] };
  }

  // Real base path for traversal guard
  let realBase;
  try { realBase = fs.realpathSync(inboxDir); } catch { realBase = inboxDir; }

  const files = entries
    .filter(e => e.isFile() && !e.isSymbolicLink())
    .filter(e => SUPPORTED_EXTS.has(path.extname(e.name).toLowerCase()))
    .slice(0, MAX_FILES_PER_RUN);

  let processed = 0;
  let errors    = 0;
  const titles  = [];

  for (const entry of files) {
    const filePath = path.join(inboxDir, entry.name);

    // Symlink guard via lstat
    let lstat;
    try { lstat = fs.lstatSync(filePath); } catch { continue; }
    if (lstat.isSymbolicLink()) {
      logger?.warn({ file: entry.name }, 'inbox: symlink skipped');
      continue;
    }

    // Path traversal guard via realpath
    let realFile;
    try { realFile = fs.realpathSync(filePath); } catch { continue; }
    if (!realFile.startsWith(realBase + path.sep) && realFile !== realBase) {
      logger?.warn({ file: entry.name }, 'inbox: path traversal attempt, skipped');
      continue;
    }

    // Size guard
    if (lstat.size > MAX_FILE_BYTES) {
      const mb = (lstat.size / 1024 / 1024).toFixed(1);
      const reason = `Fichier trop volumineux (${mb} Mo > 2 Mo maximum).`;
      writeErrorLog(errorsDir, entry.name, reason);
      try { moveFile(filePath, errorsDir, entry.name); } catch { /* non-fatal */ }
      errors++;
      continue;
    }

    // Read
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch (err) {
      writeErrorLog(errorsDir, entry.name, `Lecture impossible : ${err.message}`);
      try { moveFile(filePath, errorsDir, entry.name); } catch { /* non-fatal */ }
      errors++;
      continue;
    }

    // Parse — content is treated as DATA, never as instructions
    let title, content, source, tags;
    const ext = path.extname(entry.name).toLowerCase();
    try {
      if (ext === '.json') {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new Error('JSON invalide.'); }
        if (typeof parsed.title !== 'string' || !parsed.title.trim()) throw new Error('Champ "title" manquant ou vide.');
        if (typeof parsed.content !== 'string' || !parsed.content.trim()) throw new Error('Champ "content" manquant ou vide.');
        title   = parsed.title.trim().slice(0, 200);
        content = parsed.content.trim();
        source  = typeof parsed.source === 'string' ? parsed.source.slice(0, 500) : null;
        tags    = Array.isArray(parsed.tags)
          ? parsed.tags.map(t => String(t).trim().slice(0, 50)).filter(Boolean).slice(0, 20)
          : [];
      } else {
        content = raw.trim();
        if (!content) throw new Error('Contenu vide.');
        title   = extractTitle(content, entry.name);
        source  = null;
        tags    = [];
      }
    } catch (err) {
      writeErrorLog(errorsDir, entry.name, `Format invalide : ${err.message}`);
      try { moveFile(filePath, errorsDir, entry.name); } catch { /* non-fatal */ }
      errors++;
      continue;
    }

    // Store as pending output for the frontend to create the page
    try {
      insertInboxPending({
        id:         crypto.randomUUID(),
        title,
        content,
        tags:       JSON.stringify(tags),
        meta:       JSON.stringify({
          inbox_source_file: entry.name,
          inbox_imported_at: new Date().toISOString(),
          ...(source ? { declared_source: source } : {}),
        }),
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      writeErrorLog(errorsDir, entry.name, `Stockage échoué : ${err.message}`);
      try { moveFile(filePath, errorsDir, entry.name); } catch { /* non-fatal */ }
      errors++;
      continue;
    }

    // Move to traites/
    try { moveFile(filePath, processedDir, entry.name); } catch (err) {
      logger?.warn({ file: entry.name, err: err.message }, 'inbox: could not move to traites/');
    }

    titles.push(title);
    processed++;
    logger?.info({ file: entry.name, title }, 'inbox: file imported');
  }

  // Record last check timestamp
  updateInboxSettings({ last_check: new Date().toISOString() }, inboxDir);

  logger?.info({ processed, errors }, 'inbox check done');
  return { processed, errors, titles };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let schedulerTimer = null;

export function startInboxWatcher({ defaultDir, logger } = {}) {
  if (schedulerTimer) return;

  async function tick() {
    const settings = getInboxSettings(defaultDir);
    if (!settings.enabled) return;
    if (settings.frequency === 'manual') return;

    const freqMs = FREQUENCY_MS[settings.frequency] ?? FREQUENCY_MS.daily;
    const lastMs = settings.last_check ? new Date(settings.last_check).getTime() : 0;
    if (Date.now() - lastMs < freqMs) return;

    const dir = settings.inbox_dir || defaultDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await runInboxCheck({ inboxDir: dir, logger });
    } catch (err) {
      logger?.warn({ err: err.message }, 'inbox scheduler: check failed');
    }
  }

  // Startup catchup — 10 s after server start to let everything settle
  setTimeout(tick, 10_000);

  // Re-check every hour; isDue() inside tick() decides if action is needed
  schedulerTimer = setInterval(tick, 60 * 60 * 1000);
  logger?.info('inbox watcher started');
}

export function stopInboxWatcher() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
