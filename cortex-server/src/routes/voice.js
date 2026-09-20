import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { TMP_DIR, ensureTmpDir, transcribeAudioFile } from '../lib/whisper.js';
import { transcribeWithGroq } from '../lib/whisper-groq.js';
import { getMeta, setMeta, getCloudKeys } from '../lib/sqlite.js';
import { isStrictLocalMode } from '../lib/strict-local.js';

const VOICE_SETTINGS_KEY   = 'voice_settings';
const PORCUPINE_MODEL_KEY  = 'voice_porcupine_model';

const DEFAULT_SETTINGS = {
  enabled: false,
  whisperMode: 'local',   // 'local' | 'groq'
  porcupineAccessKey: null,
  hasPorcupineModel: false,
};

function readSettings() {
  const stored = getMeta(VOICE_SETTINGS_KEY);
  return stored ? { ...DEFAULT_SETTINGS, ...stored } : { ...DEFAULT_SETTINGS };
}

export function createVoiceRoute({ logger }) {
  const app = new Hono();

  // GET /voice/settings
  app.get('/voice/settings', (c) => {
    return c.json(readSettings());
  });

  // POST /voice/settings — partial update
  app.post('/voice/settings', async (c) => {
    const body = await c.req.json();
    const current = readSettings();
    const allowed = ['enabled', 'whisperMode', 'porcupineAccessKey'];
    for (const key of allowed) {
      if (key in body) current[key] = body[key];
    }
    // Strict local mode disables Groq transcription automatically
    if (current.whisperMode === 'groq') {
      const settings = getMeta('router_settings') ?? {};
      if (settings.strict_local_mode) {
        current.whisperMode = 'local';
      }
    }
    setMeta(VOICE_SETTINGS_KEY, current);
    return c.json({ ok: true });
  });

  // POST /voice/porcupine-model — upload .ppn model (multipart)
  app.post('/voice/porcupine-model', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('model');
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Fichier .ppn manquant' }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    setMeta(PORCUPINE_MODEL_KEY, buf.toString('base64'));
    const current = readSettings();
    current.hasPorcupineModel = true;
    setMeta(VOICE_SETTINGS_KEY, current);
    logger.info({ size: buf.length }, 'porcupine-model-uploaded');
    return c.json({ ok: true });
  });

  // GET /voice/porcupine-model — returns { model_base64 }
  app.get('/voice/porcupine-model', (c) => {
    const b64 = getMeta(PORCUPINE_MODEL_KEY);
    if (!b64) return c.json({ error: 'Modèle Porcupine non configuré' }, 404);
    return c.json({ model_base64: b64 });
  });

  // POST /voice/transcribe — audio blob → text (used for both recording and wake-word check)
  // FormData: audio (Blob), provider ('local'|'groq'), model ('tiny'|'small')
  app.post('/voice/transcribe', async (c) => {
    const formData = await c.req.formData();
    const audio    = formData.get('audio');
    let provider   = (formData.get('provider') ?? 'local').toString();
    const model    = (formData.get('model')    ?? 'small').toString();

    if (!audio || typeof audio === 'string') {
      return c.json({ error: 'Audio manquant' }, 400);
    }

    // strict_local_mode must win regardless of what the client requested —
    // re-checked here, at the point of the actual call, not only when the
    // voice settings toggle is saved (which the client can bypass entirely
    // by sending provider=groq directly on this request).
    if (provider === 'groq' && isStrictLocalMode()) {
      provider = 'local';
    }

    ensureTmpDir();
    const id        = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const audioPath = path.join(TMP_DIR, `${id}.webm`);

    try {
      fs.writeFileSync(audioPath, Buffer.from(await audio.arrayBuffer()));

      if (provider === 'groq') {
        const keys = getCloudKeys();
        if (!keys.groq) return c.json({ error: 'Clé Groq non configurée' }, 400);
        const result = await transcribeWithGroq(audioPath, keys.groq);
        return c.json({ text: result.text ?? '', language: result.language ?? 'fr', provider: 'groq', mode: 'CLOUD' });
      }

      // Local faster-whisper
      const result = await transcribeAudioFile(audioPath, model);
      return c.json({ text: result.text ?? '', language: result.language ?? 'fr', provider: 'local', mode: 'LOCAL' });

    } catch (e) {
      logger.error({ err: e }, 'voice-transcribe-error');
      return c.json({ error: e instanceof Error ? e.message : 'Transcription échouée' }, 500);
    } finally {
      try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch { /* ignore */ }
    }
  });

  return app;
}
