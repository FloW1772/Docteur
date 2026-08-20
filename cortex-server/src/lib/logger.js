import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function createLogger({ level = 'info', logFile }) {
  const streams = [{ stream: process.stdout }];

  if (logFile) {
    ensureParentDir(logFile);
    streams.push({ stream: fs.createWriteStream(logFile, { flags: 'a' }) });
  }

  return pino({ level, base: null }, pino.multistream(streams));
}
