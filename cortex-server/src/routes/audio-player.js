import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import {
  getAudioPlayerSettings, setAudioPlayerSettings, getAudioPlayerPresets,
} from '../lib/sqlite.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav', '.flac']);

const MIME_BY_EXT = {
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
};

function scanFolder(folder) {
  if (!folder || !fs.existsSync(folder)) return [];
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map(e => ({
      name: e.name,
      path: path.join(folder, e.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function createAudioPlayerRoute({ logger }) {
  const route = new Hono();

  route.get('/audio-player/settings', (c) => {
    const settings = getAudioPlayerSettings();
    return c.json({ ...settings, presets: getAudioPlayerPresets() });
  });

  route.put('/audio-player/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (typeof body.localFolder === 'string' || body.localFolder === null) {
      updates.localFolder = body.localFolder ? body.localFolder.trim() : null;
    }
    if (Array.isArray(body.customStreams)) {
      updates.customStreams = body.customStreams
        .filter(s => s && typeof s.name === 'string' && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
        .map(s => ({ name: s.name.trim().slice(0, 100), url: s.url.trim() }))
        .slice(0, 30);
    }
    if (body.source === 'local' || body.source === 'radio') updates.source = body.source;
    if (typeof body.selectedRadioId === 'string') updates.selectedRadioId = body.selectedRadioId;
    setAudioPlayerSettings(updates);
    return c.json({ ok: true, settings: { ...getAudioPlayerSettings(), presets: getAudioPlayerPresets() } });
  });

  route.get('/audio-player/local-files', (c) => {
    const settings = getAudioPlayerSettings();
    const folder = settings.localFolder;
    if (!folder) return c.json({ folder: null, files: [] });
    if (!fs.existsSync(folder)) {
      return c.json({ folder, files: [], error: 'Dossier introuvable' }, 404);
    }
    const files = scanFolder(folder);
    return c.json({
      folder,
      files: files.map(f => ({
        name: f.name,
        url:  `/api/audio-player/file?path=${encodeURIComponent(f.path)}`,
      })),
    });
  });

  // GET /audio-player/file?path=... — sert un fichier audio local avec support des Range requests
  route.get('/audio-player/file', (c) => {
    const settings = getAudioPlayerSettings();
    const folder = settings.localFolder;
    const requested = c.req.query('path') ?? '';
    if (!folder || !requested) return c.json({ error: 'Chemin manquant' }, 400);

    const folderAbs = path.resolve(folder);
    const fileAbs   = path.resolve(requested);
    if (!fileAbs.startsWith(folderAbs + path.sep) && fileAbs !== folderAbs) {
      return c.json({ error: 'Chemin en dehors du dossier configuré' }, 403);
    }

    const ext = path.extname(fileAbs).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return c.json({ error: 'Extension non autorisée' }, 403);
    if (!fs.existsSync(fileAbs)) return c.json({ error: 'Fichier introuvable' }, 404);

    const stat = fs.statSync(fileAbs);
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const rangeHeader = c.req.header('range');

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end   = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(fileAbs, { start, end });
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type':   mime,
          },
        });
      }
    }

    const stream = fs.createReadStream(fileAbs);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type':   mime,
        'Accept-Ranges':  'bytes',
      },
    });
  });

  return route;
}
