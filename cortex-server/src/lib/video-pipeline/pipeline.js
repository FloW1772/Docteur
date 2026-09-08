// Pipeline résumable de résumé de vidéo longue.
// Étapes persistées en base (video_jobs / video_job_segments) : téléchargement
// audio → découpage → transcription (via transcription-manager, provider
// opaque) → découpage en chunks 10-20 min sur limites naturelles → résumé de
// chaque chunk (local par défaut) → synthèse finale (local ou cloud, avec
// exemples de style). Une interruption/crash reprend au segment non terminé,
// jamais depuis zéro.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeUrl } from '../url-security.js';
import { downloadAudio, ensureTmpDir, splitAudioFile, getVideoDuration } from '../whisper.js';
import { transcribeSegment, fileSizeBytes } from './transcription-manager.js';
import {
  getVideoJobById, updateVideoJob, getSegmentsByJobId,
  insertVideoJobSegment, updateVideoJobSegment,
  getRouterSettings, getCloudKeys, savePageToStoreIfNewer,
  getStyleExampleSettings,
} from '../sqlite.js';
import { chatCompletion } from '../ollama.js';
import { completeWithCascade } from '../providers/gemini.js';
import { complete as groqComplete } from '../providers/groq.js';
import { registerJob, updateJob, finishJob } from '../../routes/jobs.js';
import { findStyleExamples, buildStyleExamplesBlock, describeUsedExamples } from '../style-examples.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const JOBS_DIR = path.join(ROOT, 'data', 'video-jobs');

const CHUNK_TARGET_S = 15 * 60; // ~15 min, entre les 10-20 min demandés
const CHUNK_MIN_S    = 10 * 60;
const CHUNK_MAX_S    = 20 * 60;
const GROQ_MAX_BYTES = 100 * 1024 * 1024;

function jobDir(jobId) { return path.join(JOBS_DIR, jobId); }

// ── Registre en mémoire pour piloter le panneau de progression (registre B,
// voir routes/jobs.js) + pour permettre l'annulation coopérative ───────────
const runtime = new Map(); // jobId -> { cancelRequested, uiJobId }

export function requestCancel(jobId) {
  const r = runtime.get(jobId);
  if (r) r.cancelRequested = true;
  updateVideoJob(jobId, { cancelled: true });
}

function isCancelled(jobId) {
  const job = getVideoJobById(jobId);
  return job?.cancelled === true || runtime.get(jobId)?.cancelRequested === true;
}

// ── Estimation (avant lancement) ──────────────────────────────────────────

export async function estimateVideo(url) {
  assertSafeUrl(url);
  const duration_s = await getVideoDuration(url);
  if (!duration_s) {
    return { ok: false, error: "Impossible de déterminer la durée de la vidéo." };
  }
  const chunkCount = Math.max(1, Math.round(duration_s / CHUNK_TARGET_S));
  // Whisper local ≈ temps réel de la vidéo ; Groq beaucoup plus rapide mais
  // soumis à quota (donc non garanti).
  const localTranscriptionMinutes = Math.round(duration_s / 60);
  const groqTranscriptionMinutes  = Math.max(1, Math.round(duration_s / 60 / 8));
  // Résumé de chaque chunk : ~20-40s en local par chunk, synthèse finale ~30-60s.
  const summarizeMinutes = Math.round((chunkCount * 30) / 60) + 1;
  const keys = getCloudKeys();
  const groqAvailable = !!keys.groq_key;

  const totalMinutesLocal = localTranscriptionMinutes + summarizeMinutes;
  const requiresConfirmation = duration_s > 3600;

  return {
    ok: true,
    duration_s,
    duration_label: formatDuration(duration_s),
    chunk_count_estimate: chunkCount,
    transcription_minutes_local: localTranscriptionMinutes,
    transcription_minutes_groq: groqAvailable ? groqTranscriptionMinutes : null,
    summarization_minutes_estimate: summarizeMinutes,
    total_minutes_estimate_local: totalMinutesLocal,
    groq_available: groqAvailable,
    requires_confirmation: requiresConfirmation,
    confirmation_message: requiresConfirmation
      ? `Une vidéo de ${formatDuration(duration_s)} représente environ ${(totalMinutesLocal / 60).toFixed(1)} heures de traitement. Votre PC sera occupé pendant ce temps.`
      : null,
  };
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

// ── Registre UI (BatchProgressModal) — voir routes/jobs.js hasActiveJobs() ──

async function registerUiJob(jobId, total, operation) {
  try { return registerJob(jobId, operation, total); } catch { return jobId; }
}

async function pushUiProgress(uiJobId, updates) {
  try { updateJob(uiJobId, updates); } catch { /* UI progress is best-effort — never fail the pipeline for it */ }
}

async function finishUiJob(uiJobId, status, summary) {
  try { finishJob(uiJobId, status, summary); } catch { /* best-effort */ }
}

// ── Étape 1-2 : téléchargement + découpage en segments ──────────────────────

function buildNaturalChunks(segments, totalDurationS) {
  // segments: [{start,end,text}] triés — coupe au plus près de CHUNK_TARGET_S
  // en tombant toujours sur une frontière de segment Whisper (donc sur une
  // pause naturelle de parole), au lieu de trancher aveuglément.
  if (!Array.isArray(segments) || segments.length === 0) {
    // Pas de timestamps disponibles (ex. transcription Groq) → découpage par
    // durée fixe, faute de mieux.
    const chunks = [];
    let t = 0;
    while (t < totalDurationS) {
      const end = Math.min(totalDurationS, t + CHUNK_TARGET_S);
      chunks.push({ start: t, end, text: null });
      t = end;
    }
    return chunks;
  }

  const chunks = [];
  let chunkStart = segments[0].start;
  let accText = [];
  let accStart = chunkStart;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    accText.push(seg.text);
    const elapsed = seg.end - accStart;
    const isLast = i === segments.length - 1;
    if ((elapsed >= CHUNK_TARGET_S && elapsed >= CHUNK_MIN_S) || elapsed >= CHUNK_MAX_S || isLast) {
      chunks.push({ start: accStart, end: seg.end, text: accText.join(' ') });
      accText = [];
      accStart = seg.end;
    }
  }
  return chunks;
}

// ── Résumé d'un chunk (local par défaut) ────────────────────────────────────

async function summarizeChunkLocal(ollamaClient, model, chunkText, idx, total) {
  const prompt = `Tu résumes un extrait (partie ${idx + 1}/${total}) de la transcription d'une vidéo longue. Résume fidèlement les points importants de cet extrait, en français, sous forme de points clés concis. N'invente aucun fait, reste strictement fidèle au texte fourni.

Transcription de l'extrait :
"""
${chunkText.slice(0, 12000)}
"""

Résumé de l'extrait :`;
  const response = await chatCompletion(ollamaClient, model, [{ role: 'user', content: prompt }]);
  return response.trim();
}

// ── Synthèse finale : construction du prompt (exemples de style via le module partagé) ──

function buildSynthesisPrompt({ chunkSummaries, examples, resumeType, videoTitle }) {
  const examplesBlock = buildStyleExamplesBlock(examples);

  return `Tu rédiges la synthèse finale du résumé d'une vidéo longue ("${videoTitle ?? 'vidéo'}", type : ${resumeType ?? 'auto'}), à partir des résumés successifs de chaque partie de la vidéo, ci-dessous.

RÈGLES IMPÉRATIVES :
- Reste strictement fidèle aux résumés fournis. N'invente AUCUN fait, nom, chiffre ou événement qui n'y figure pas.
- Si des exemples de style sont fournis, reproduis leur structure, leur ton, leur niveau de détail et leur mise en forme — mais jamais leur contenu ni leurs mots.
- Produis un document cohérent et bien structuré, pas une simple concaténation des résumés partiels.
${examplesBlock}

Résumés successifs de la vidéo (dans l'ordre chronologique) :

${chunkSummaries.map((s, i) => `### Partie ${i + 1}\n${s}`).join('\n\n')}

Synthèse finale :`;
}

// ── Étape principale : exécute (ou reprend) le pipeline complet ────────────

export async function runVideoPipeline(jobId, { ollamaClient, services, logger } = {}) {
  const job = getVideoJobById(jobId);
  if (!job) throw new Error('Job introuvable');

  runtime.set(jobId, { cancelRequested: false });
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  let segments = getSegmentsByJobId(jobId);
  let uiJobId = jobId;

  try {
    // ── Étape a/b : téléchargement + découpage en segments audio ──────────
    if (segments.length === 0) {
      updateVideoJob(jobId, { status: 'downloading', current_step: 'Téléchargement audio…' });
      uiJobId = await registerUiJob(jobId, 1, 'Résumé de vidéo longue — téléchargement');
      await pushUiProgress(uiJobId, { currentLabel: 'Téléchargement audio…' });

      ensureTmpDir();
      const fullAudioPath = path.join(dir, 'full.wav');
      await downloadAudio(job.url, fullAudioPath.replace(/\.wav$/, '.%(ext)s'));
      const actualPath = fs.existsSync(fullAudioPath)
        ? fullAudioPath
        : fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => f.includes('full')) ?? fullAudioPath;

      if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }

      updateVideoJob(jobId, { status: 'chunking', current_step: 'Découpage audio…' });
      const durationS = job.duration_s ?? (await getVideoDuration(job.url)) ?? 0;
      const chunkCount = Math.max(1, Math.round(durationS / CHUNK_TARGET_S));
      const segSeconds = Math.max(CHUNK_MIN_S, Math.min(CHUNK_MAX_S, Math.ceil(durationS / chunkCount)));
      const audioChunks = await splitAudioFile(actualPath, dir, segSeconds);

      audioChunks.forEach((chunkPath, idx) => {
        insertVideoJobSegment({
          id: crypto.randomUUID(), job_id: jobId, idx,
          start_s: idx * segSeconds,
          end_s: Math.min(durationS, (idx + 1) * segSeconds),
          audio_path: chunkPath,
        });
      });

      try { fs.unlinkSync(actualPath); } catch { /* cleanup best-effort */ }
      segments = getSegmentsByJobId(jobId);
    } else {
      uiJobId = await registerUiJob(jobId, segments.length, 'Résumé de vidéo longue — reprise');
    }

    if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }

    // ── Étape c/d : transcription (segments non encore transcrits) ────────
    updateVideoJob(jobId, { status: 'transcribing', current_step: `Transcription 0/${segments.length} segments` });
    let transcribedCount = segments.filter(s => s.transcript_status === 'done').length;

    for (const seg of segments) {
      if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }
      if (seg.transcript_status === 'done') continue;
      if (!seg.audio_path || !fs.existsSync(seg.audio_path)) {
        updateVideoJobSegment(seg.id, { transcript_status: 'error', error_message: 'Fichier audio manquant' });
        continue;
      }

      await pushUiProgress(uiJobId, {
        current: transcribedCount, currentLabel: `Transcription ${transcribedCount}/${segments.length} segments`,
      });
      updateVideoJob(jobId, { current_step: `Transcription ${transcribedCount}/${segments.length} segments` });

      try {
        const result = await transcribeSegment(seg.audio_path, job.provider_whisper, {
          onFallback: (fb) => {
            logger?.warn({ jobId, segmentId: seg.id, ...fb }, 'VIDEO_PIPELINE_WHISPER_FALLBACK');
            pushUiProgress(uiJobId, { currentLabel: fb.label });
          },
        });
        updateVideoJobSegment(seg.id, {
          transcript: result.text,
          transcript_status: 'done',
        });
        if (Array.isArray(result.segments) && result.segments.length) {
          updateVideoJobSegment(seg.id, { error_message: null });
          seg._innerSegments = result.segments; // used only in-memory for natural sub-chunking below
        }
      } catch (err) {
        logger?.warn({ jobId, segmentId: seg.id, err: err.message }, 'VIDEO_PIPELINE_SEGMENT_TRANSCRIPTION_FAILED');
        updateVideoJobSegment(seg.id, { transcript_status: 'error', error_message: err.message });
      }
      transcribedCount++;
      // Clean up the audio chunk once transcribed (success or failure) — disk hygiene.
      try { fs.unlinkSync(seg.audio_path); } catch { /* ignore */ }
    }

    if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }

    // ── Étape e : résumé de chaque segment transcrit (local par défaut) ────
    segments = getSegmentsByJobId(jobId);
    const transcribedSegments = segments.filter(s => s.transcript_status === 'done' && s.transcript?.trim());
    updateVideoJob(jobId, { status: 'summarizing', current_step: `Résumés 0/${transcribedSegments.length}` });

    const routerSettings = getRouterSettings();
    const localModel = routerSettings.powerful_model ?? 'qwen2.5:14b-instruct-q3_K_M';

    let summarizedCount = segments.filter(s => s.summary_status === 'done').length;
    for (const seg of transcribedSegments) {
      if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }
      if (seg.summary_status === 'done') continue;

      await pushUiProgress(uiJobId, {
        currentLabel: `Transcription ${transcribedCount}/${segments.length} · Résumés ${summarizedCount}/${transcribedSegments.length}`,
      });
      updateVideoJob(jobId, { current_step: `Résumés ${summarizedCount}/${transcribedSegments.length}` });

      try {
        const summary = await summarizeChunkLocal(ollamaClient, localModel, seg.transcript, seg.idx, transcribedSegments.length);
        updateVideoJobSegment(seg.id, { summary, summary_status: 'done' });
      } catch (err) {
        logger?.warn({ jobId, segmentId: seg.id, err: err.message }, 'VIDEO_PIPELINE_SEGMENT_SUMMARY_FAILED');
        updateVideoJobSegment(seg.id, { summary_status: 'error', error_message: err.message });
      }
      summarizedCount++;
    }

    if (isCancelled(jobId)) { await cleanupAndStop(jobId, uiJobId); return; }

    // ── Étape f : synthèse finale ────────────────────────────────────────
    updateVideoJob(jobId, { status: 'synthesizing', current_step: 'Synthèse en cours…' });
    await pushUiProgress(uiJobId, { currentLabel: 'Synthèse en cours…' });

    segments = getSegmentsByJobId(jobId);
    const chunkSummaries = segments.filter(s => s.summary_status === 'done' && s.summary?.trim()).map(s => s.summary);
    const failedSegments = segments.filter(s => s.transcript_status === 'error' || s.summary_status === 'error');

    if (chunkSummaries.length === 0) {
      throw new Error('Aucun segment n\'a pu être résumé — synthèse impossible.');
    }

    const styleSettings = getStyleExampleSettings();
    const examples = styleSettings.enabled
      ? await findStyleExamples(services, { type: job.resume_type, queryText: job.title })
      : [];
    const prompt = buildSynthesisPrompt({ chunkSummaries, examples, resumeType: job.resume_type, videoTitle: job.title });
    const usedExamples = describeUsedExamples(examples);

    // Cloud gating — verrou mode strict + confidentialité du job, avant tout appel cloud.
    let synthesisProvider = job.provider_synthesis ?? 'local';
    if (synthesisProvider !== 'local') {
      if (routerSettings?.strict_local_mode === true || job.private) {
        logger?.info({ jobId }, 'VIDEO_PIPELINE_SYNTHESIS_FORCED_LOCAL');
        synthesisProvider = 'local';
      }
    }

    let synthesisText;
    let synthesisModelUsed;
    if (synthesisProvider === 'local') {
      synthesisText = await chatCompletion(ollamaClient, localModel, [{ role: 'user', content: prompt }]);
      synthesisModelUsed = localModel;
    } else if (synthesisProvider === 'gemini') {
      const keys = getCloudKeys();
      if (!keys.gemini_key) throw new Error('Clé Gemini non configurée — synthèse cloud impossible.');
      const result = await completeWithCascade({ apiKey: keys.gemini_key, messages: [{ role: 'user', content: prompt }], maxTokens: 8192, logger });
      synthesisText = result.text;
      synthesisModelUsed = result.model;
    } else if (synthesisProvider === 'groq') {
      const keys = getCloudKeys();
      if (!keys.groq_key) throw new Error('Clé Groq non configurée — synthèse cloud impossible.');
      const result = await groqComplete({ apiKey: keys.groq_key, messages: [{ role: 'user', content: prompt }], model: routerSettings.groq_model });
      synthesisText = result.text ?? result.response ?? '';
      synthesisModelUsed = routerSettings.groq_model;
    } else {
      throw new Error(`Provider de synthèse inconnu : ${synthesisProvider}`);
    }

    // ── Création du neurone principal (synthèse) + neurones liés (résumés intermédiaires) ──
    const now = Date.now();
    const childIds = [];
    transcribedSegments.forEach((seg, i) => {
      if (seg.summary_status !== 'done') return;
      const childId = crypto.randomUUID();
      childIds.push(childId);
      savePageToStoreIfNewer({
        id: childId,
        title: `${job.title ?? 'Vidéo'} — partie ${i + 1}`,
        kind: 'note',
        blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: seg.summary }],
        createdAt: now,
        updatedAt: now,
        links: [],
        metadata: { video_job_id: jobId, segment_idx: seg.idx, start_s: seg.start_s, end_s: seg.end_s, not_indexed: true },
        private: !!job.private,
      });
    });

    const neuronId = crypto.randomUUID();
    const diskBytes = computeDiskUsage(jobId);
    const mainNeuron = {
      id: neuronId,
      title: job.title ?? 'Résumé de vidéo',
      kind: 'video_summary',
      blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: synthesisText.trim() }],
      createdAt: now,
      updatedAt: now,
      links: childIds,
      private: !!job.private,
      metadata: {
        video_url: job.url,
        duration_s: job.duration_s,
        segment_count: segments.length,
        failed_segment_count: failedSegments.length,
        providers: { transcription: job.provider_whisper, synthesis: synthesisProvider, synthesis_model: synthesisModelUsed },
        job_id: jobId,
        disk_bytes: diskBytes,
        date: new Date().toISOString(),
        ...(usedExamples.length > 0 ? { style_examples_used: usedExamples } : {}),
      },
    };
    savePageToStoreIfNewer(mainNeuron);

    // Indexation sémantique : uniquement la synthèse finale (le transcript
    // complet n'est jamais indexé — trop long, polluerait la recherche).
    if (services?.indexNeuron) {
      try {
        await services.indexNeuron({ id: neuronId, title: mainNeuron.title, content: synthesisText, kind: 'video_summary', metadata: mainNeuron.metadata });
      } catch (err) {
        logger?.warn({ jobId, err: err.message }, 'VIDEO_PIPELINE_INDEX_FAILED');
      }
    }

    updateVideoJob(jobId, {
      status: 'done', current_step: 'Terminé',
      neuron_id: neuronId, disk_bytes: diskBytes,
      metadata: { failed_segment_count: failedSegments.length, failed_segments: failedSegments.map(s => ({ idx: s.idx, error: s.error_message })) },
    });

    const summary = failedSegments.length > 0
      ? `Terminé avec ${failedSegments.length} segment(s) en échec (ignorés dans la synthèse).`
      : 'Résumé de vidéo terminé.';
    await finishUiJob(uiJobId, 'done', summary);
    logger?.info({ jobId, neuronId, failedCount: failedSegments.length }, 'VIDEO_PIPELINE_DONE');
  } catch (err) {
    logger?.error({ jobId, err: err.message }, 'VIDEO_PIPELINE_ERROR');
    updateVideoJob(jobId, { status: 'error', error_message: err.message });
    await finishUiJob(uiJobId, 'error', err.message);
  } finally {
    runtime.delete(jobId);
    cleanupJobTmpFiles(jobId);
  }
}

async function cleanupAndStop(jobId, uiJobId) {
  updateVideoJob(jobId, { status: 'cancelled', current_step: 'Annulé — progression conservée' });
  await finishUiJob(uiJobId, 'cancelled', 'Annulé par l\'utilisateur — travail effectué conservé.');
  cleanupJobTmpFiles(jobId);
}

// Supprime les fichiers audio temporaires restants (le transcript/résumé en
// base est conservé) — nettoyage en succès comme en échec/annulation.
function cleanupJobTmpFiles(jobId) {
  try {
    const dir = jobDir(jobId);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.wav')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function computeDiskUsage(jobId) {
  let total = 0;
  try {
    const dir = jobDir(jobId);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) total += fileSizeBytes(path.join(dir, f));
    }
  } catch { /* ignore */ }
  const segments = getSegmentsByJobId(jobId);
  for (const s of segments) {
    total += Buffer.byteLength(s.transcript ?? '', 'utf8') + Buffer.byteLength(s.summary ?? '', 'utf8');
  }
  return total;
}

// Supprime entièrement le répertoire de travail d'un job (audio restant
// compris) — utilisé quand le job lui-même est supprimé (DELETE
// /api/video-summary/jobs/:id), au-delà du nettoyage .wav de routine.
export function removeJobDir(jobId) {
  try {
    const dir = jobDir(jobId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

export { buildNaturalChunks, jobDir };
