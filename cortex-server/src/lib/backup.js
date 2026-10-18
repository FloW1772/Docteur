import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAllNeuronsForBackup } from './lancedb.js';
import { buildBackupSnapshot } from './backup-snapshot.js';

const MAX_BACKUPS = 30;
const MS_PER_DAY  = 24 * 60 * 60 * 1000;

function getBackupsDir(lancedbPath) {
  return path.join(path.dirname(path.resolve(lancedbPath)), 'backups');
}

function ensureBackupsDir(lancedbPath) {
  const dir = getBackupsDir(lancedbPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listBackups(lancedbPath) {
  const dir = ensureBackupsDir(lancedbPath);
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .map(name => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { name, size_bytes: stat.size, exported_at: raw.exported_at ?? null, neurons_count: raw.neurons_count ?? 0 };
      } catch {
        return { name, size_bytes: stat.size, exported_at: null, neurons_count: 0 };
      }
    });
}

export async function runBackup(lancedbPath) {
  const dir = ensureBackupsDir(lancedbPath);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `backup-${dateStr}.json`;
  const filePath = path.join(dir, filename);

  const neurons = await getAllNeuronsForBackup(lancedbPath);

  const payload = buildBackupSnapshot(neurons, now);

  // Atomic write: write to a temp file then rename, so a crash/power-loss
  // mid-write can never leave a truncated/corrupt backup-YYYY-MM-DD.json —
  // rename() is atomic on both POSIX and NTFS for same-volume paths.
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  // Rotation: keep only MAX_BACKUPS, delete oldest
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort();
  if (files.length > MAX_BACKUPS) {
    for (const f of files.slice(0, files.length - MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }

  return { filename, neurons_count: payload.neurons_count, exported_at: now.toISOString() };
}

async function runBackupIfNotDoneToday(lancedbPath) {
  const dir = ensureBackupsDir(lancedbPath);
  const dateStr = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(path.join(dir, `backup-${dateStr}.json`))) return null;
  return runBackup(lancedbPath);
}

export function scheduleDailyBackup(lancedbPath, logger) {
  // On startup: run after 10s if no backup exists for today
  setTimeout(async () => {
    try {
      const result = await runBackupIfNotDoneToday(lancedbPath);
      if (result) logger.info(result, 'startup backup completed');
    } catch (err) {
      logger.error({ error: err.message }, 'startup backup failed');
    }
  }, 10_000);

  // Then every 24h
  setInterval(async () => {
    try {
      const result = await runBackup(lancedbPath);
      logger.info(result, 'daily backup completed');
    } catch (err) {
      logger.error({ error: err.message }, 'daily backup failed');
    }
  }, MS_PER_DAY);
}
