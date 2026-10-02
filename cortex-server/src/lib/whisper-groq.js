import fs from 'node:fs';
import path from 'node:path';
import { getRouterSettings } from './sqlite.js';
import { enforceCloudAi } from './root-policy/index.js';

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const TIMEOUT_MS = 180_000; // 3 minutes

/**
 * Transcribe an audio file via Groq's Whisper API.
 * Throws with .isTooLarge = true if file > 100 MB.
 * Throws with .isQuota  = true on HTTP 429.
 * API key is never included in thrown error messages.
 */
export async function transcribeWithGroq(audioPath, apiKey) {
  // ROOT POLICY (AI_CLOUD_REQUEST): audio leaves the machine — strict local, explicit cloud opt-in, fail closed on an untrusted policy.
  let settings = null;
  try { settings = getRouterSettings(); } catch { /* db not ready: defaults */ }
  enforceCloudAi({ provider: 'groq-whisper', messages: [], strictLocal: settings?.strict_local_mode === true, cloudEnabled: settings?.cloud_enabled !== false });
  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_FILE_BYTES) {
    const err = new Error(
      `Audio trop volumineux pour Groq : ${(stat.size / 1024 / 1024).toFixed(1)} MB > 100 MB`,
    );
    err.isTooLarge = true;
    throw err;
  }

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([fs.readFileSync(audioPath)], { type: 'audio/wav' }),
    path.basename(audioPath),
  );
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      if (res.status === 429) {
        const e = new Error('Groq Whisper : quota atteint (429)');
        e.isQuota = true;
        throw e;
      }
      const body = await res.json().catch(() => ({}));
      throw new Error(`Groq Whisper ${res.status}: ${body?.error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const text = data.text ?? '';
    if (!text.trim()) throw new Error('Groq Whisper : transcription vide');
    return { text, language: data.language ?? '' };
  } finally {
    clearTimeout(timer);
  }
}
