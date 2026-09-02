import fs from 'node:fs';
import { Hono } from 'hono';
import { getImagePath, validateImageId } from '../lib/image.js';
import { verifyModelAvailability, chatCompletion } from '../lib/ollama.js';
import { insertActivityLog } from '../lib/sqlite.js';
import { hasActiveJobs } from './jobs.js';

// llava:7b (~4.7 Go, quantification Q4) plutôt que qwen2-vl:7b (~6 Go+, exige
// une version récente d'Ollama) : sur une carte 8 Go, llava laisse une marge
// confortable pour le contexte + l'overhead système, et bénéficie d'un
// support Ollama plus ancien/éprouvé — priorité à la fiabilité sur la carte
// ciblée plutôt qu'au dernier point de précision.
const VISION_MODEL = process.env.VISION_MODEL ?? 'llava:7b';

// Above this, inference is considered stuck rather than just slow — abort and
// fall back to OCR instead of leaving the user waiting indefinitely.
const VISION_TIMEOUT_MS = 90_000;

const VISION_SYSTEM_PROMPT =
  "Tu es un assistant de vision fonctionnant entièrement en local. Réponds en " +
  "français, de façon factuelle et concise, en te basant uniquement sur ce " +
  "que tu vois. Si un détail est illisible, flou, trop petit ou ambigu, dis-le " +
  "explicitement (ex: \"le texte est trop petit pour être lu avec certitude\") " +
  "plutôt que d'inventer une réponse.";

function isMemoryError(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('memory') || msg.includes('vram') || msg.includes('out of') || msg.includes('cuda');
}

export function createVisionRoute({ ollamaClient, env, logger }) {
  const app = new Hono();

  app.get('/vision/status', async (c) => {
    const installed = await verifyModelAvailability(ollamaClient, VISION_MODEL).catch(() => false);
    return c.json({ model: VISION_MODEL, installed, gpu_busy: hasActiveJobs() });
  });

  app.post('/vision/analyze', async (c) => {
    const body      = await c.req.json().catch(() => null);
    const imageId   = body?.imageId;
    const question  = String(body?.question ?? '').trim();

    if (!validateImageId(imageId)) return c.json({ ok: false, error: 'Image invalide' }, 400);
    if (!question) return c.json({ ok: false, error: 'Question manquante' }, 400);
    if (question.length > 2000) return c.json({ ok: false, error: 'Question trop longue (max 2000 caractères)' }, 400);

    const installed = await verifyModelAvailability(ollamaClient, VISION_MODEL).catch(() => false);
    if (!installed) {
      return c.json({
        ok: false,
        model_installed: false,
        fallback_suggested: true,
        error: `Modèle de vision "${VISION_MODEL}" non installé. Installez-le depuis Réglages → Modèles Ollama (~4.7 Go, 100% local), ou utilisez l'OCR en attendant.`,
      });
    }

    // A batch/transcription job already saturates the GPU — starting a 4-5 Go
    // vision load on top of it risks a slow/failed load. Warn instead of
    // silently degrading; the client can still force it if it wants OCR
    // instead, or retry once the other job finishes.
    if (hasActiveJobs()) {
      return c.json({
        ok: false,
        gpu_busy: true,
        fallback_suggested: true,
        error: 'Un autre traitement GPU est en cours (lot, transcription…). Utilisez l\'OCR maintenant, ou réessayez la vision une fois ce traitement terminé.',
      });
    }

    let imagePath;
    try { imagePath = getImagePath(imageId); } catch { return c.json({ ok: false, error: 'Image invalide' }, 400); }
    if (!fs.existsSync(imagePath)) return c.json({ ok: false, error: 'Image introuvable' }, 404);

    const started = Date.now();
    try {
      const buffer = fs.readFileSync(imagePath);
      const base64 = buffer.toString('base64');

      const chatPromise = ollamaClient.chat({
        model:    VISION_MODEL,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content: question, images: [base64] },
        ],
        stream: false,
        // Released immediately after inference — a vision model and qwen2.5:7b
        // don't both fit in 8 GB VRAM. The answer model is re-warmed below.
        keep_alive: 0,
        options: { temperature: 0.2 },
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('TIMEOUT')), VISION_TIMEOUT_MS);
      });

      const response = await Promise.race([chatPromise, timeoutPromise]);
      const answer     = response?.message?.content ?? '';
      const latency_ms = Date.now() - started;

      // Vision model just released its VRAM (keep_alive: 0 above) — re-warm
      // the normal answer model now so the next question doesn't hit a cold
      // reload. Same fire-and-forget pattern already used for
      // nomic-embed-text after "powerful mode" (qwen2.5:14b) in server.js.
      chatCompletion(ollamaClient, env.ANSWER_MODEL, [{ role: 'user', content: 'warmup' }]).catch(() => {});

      // No image content, no answer content — question text only (already
      // the pattern used for regular Q&A activity-log entries).
      insertActivityLog({
        opType: 'vision_analyze', item: question.slice(0, 200),
        result: 'success', durationMs: latency_ms, modelUsed: VISION_MODEL,
      });

      return c.json({ ok: true, answer, model_used: VISION_MODEL, latency_ms });
    } catch (err) {
      const timedOut = err.message === 'TIMEOUT';
      const memErr    = isMemoryError(err);
      logger?.error({ err: err.message, timedOut, memErr }, 'vision analyze failed');

      // Release the model's VRAM slot explicitly on failure too — a stuck/
      // failed load must never leave VRAM occupied for the next attempt.
      // Also re-warm the answer model so a normal question right after this
      // failure doesn't ALSO pay a cold-load penalty.
      unloadVisionModel(ollamaClient).catch(() => {});
      chatCompletion(ollamaClient, env.ANSWER_MODEL, [{ role: 'user', content: 'warmup' }]).catch(() => {});

      insertActivityLog({
        opType: 'vision_analyze', item: question.slice(0, 200),
        result: 'failure', reason: timedOut ? 'timeout' : memErr ? 'memory' : err.message, durationMs: Date.now() - started,
      });

      const reasonMessage = timedOut
        ? `L'analyse a dépassé ${VISION_TIMEOUT_MS / 1000} s sans réponse — le modèle de vision semble bloqué.`
        : memErr
          ? 'Mémoire GPU insuffisante pour charger le modèle de vision.'
          : `Erreur Ollama : ${err.message}`;

      // Local failure only — this route never has a cloud fallback path.
      return c.json({
        ok: false,
        fallback_suggested: true,
        error: `${reasonMessage} Utilisez l'OCR à la place.`,
      });
    }
  });

  return app;
}

async function unloadVisionModel(ollamaClient) {
  await ollamaClient.chat({ model: VISION_MODEL, messages: [{ role: 'user', content: '' }], stream: false, keep_alive: 0 });
}
