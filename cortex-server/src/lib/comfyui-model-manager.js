// Local model catalog + real download/delete for ComfyUI checkpoints.
//
// No arbitrary frontend-supplied download URL is ever accepted — only ids
// from MODEL_CATALOG below (an explicit allowlist of vetted entries).
//
// Catalog kept deliberately small (mission: "1 à 3 modèles maximum pour
// commencer"). Each entry's size/license/source was verified directly
// against the Hugging Face repo before being added here — never invented.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerJob, updateJob, finishJob } from '../routes/jobs.js';
import { getInstallState, assertSafeInstallPath } from './comfyui-install-manager.js';

// Verified against https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive
// (file size and license read directly from the repo's file listing).
export const MODEL_CATALOG = [
  {
    id: 'sd15-pruned-emaonly-fp16',
    name: 'Stable Diffusion 1.5 (pruned, emaonly, fp16)',
    filename: 'v1-5-pruned-emaonly-fp16.safetensors',
    source: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors',
    license: 'CreativeML Open RAIL-M',
    approxSizeGb: 2.13,
    capabilities: { text_to_image: true, image_to_image: false, image_edit: false, negative_prompt: true, seed: true, custom_size: true },
    recommendedVramGb: 4,
  },
];

export function getModelCatalog() {
  return MODEL_CATALOG;
}

// Real detection of *installed* checkpoints comes from ComfyUI's own
// /object_info (see providers/comfyui.js getComfyUiStatus().checkpoints) —
// this module only adds catalog + download/delete actions on top of that.

function checkpointsDir(installPath) {
  return path.join(installPath, 'ComfyUI', 'models', 'checkpoints');
}

const activeDownloads = new Map(); // jobId -> AbortController

export function startModelDownload(modelId) {
  const entry = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!entry) {
    throw new Error('Modèle inconnu ou non autorisé');
  }
  const install = getInstallState();
  if (install.status === 'not_installed' || !install.path) {
    throw new Error('ComfyUI n’est pas installé');
  }
  const installPath = assertSafeInstallPath(install.path);
  const destDir = checkpointsDir(installPath);
  fs.mkdirSync(destDir, { recursive: true });

  const neededBytes = entry.approxSizeGb * 1024 * 1024 * 1024 * 1.1;
  const stat = fs.statfsSync(destDir);
  const freeBytes = stat.bavail * stat.bsize;
  if (freeBytes < neededBytes) {
    throw new Error(`Espace disque insuffisant : ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} Go disponibles, ${(neededBytes / 1024 / 1024 / 1024).toFixed(1)} Go requis`);
  }

  const jobId = randomUUID();
  registerJob(jobId, `Téléchargement modèle: ${entry.name}`, 100);
  const controller = new AbortController();
  activeDownloads.set(jobId, controller);

  void runModelDownload(jobId, entry, destDir, controller.signal).finally(() => activeDownloads.delete(jobId));

  return { jobId, model: entry };
}

async function runModelDownload(jobId, entry, destDir, signal) {
  const finalPath = path.join(destDir, entry.filename);
  const tmpPath = `${finalPath}.download.tmp`;

  try {
    const res = await fetch(entry.source, { signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Téléchargement HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || Math.round(entry.approxSizeGb * 1024 * 1024 * 1024);
    let received = 0;
    let lastPct = -1;

    const fileStream = fs.createWriteStream(tmpPath);
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        await new Promise((resolve, reject) => {
          fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          updateJob(jobId, { current: pct, currentLabel: `Téléchargement… ${pct}%` });
        }
      }
    } finally {
      await new Promise((resolve) => fileStream.end(resolve));
    }

    if (signal.aborted) throw new Error('cancelled');
    if (total > 0 && received < total * 0.99) {
      throw new Error(`Téléchargement incomplet (${received}/${total} octets)`);
    }

    // Atomic finalize — a partial download never appears as an installed model.
    fs.renameSync(tmpPath, finalPath);
    updateJob(jobId, { current: 100, currentLabel: 'Téléchargement terminé' });
    finishJob(jobId, 'done', { modelId: entry.id, filename: entry.filename });
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    const cancelled = err.message === 'cancelled' || signal.aborted;
    finishJob(jobId, cancelled ? 'cancelled' : 'failed', { errorCode: cancelled ? 'cancelled' : 'download_failed' });
  }
}

export function cancelModelDownload(jobId) {
  const controller = activeDownloads.get(jobId);
  if (!controller) throw new Error('Aucun téléchargement en cours avec cet identifiant');
  controller.abort();
  return { ok: true };
}

// Deletes exactly one named checkpoint file — never the whole checkpoints
// directory. Filename must be bare (no path separators/traversal) and must
// resolve inside the registered install's checkpoints directory.
export function deleteModel(filename) {
  if (typeof filename !== 'string' || !filename || /[\\/]/.test(filename) || filename.includes('..')) {
    throw new Error('Nom de fichier de modèle invalide');
  }
  const install = getInstallState();
  if (!install.path) {
    throw new Error('ComfyUI n’est pas installé');
  }
  const installPath = assertSafeInstallPath(install.path);
  const destDir = checkpointsDir(installPath);
  const target = path.join(destDir, filename);

  // Re-validate the resolved path stays inside destDir even after join
  // (defense in depth beyond the separator/traversal check above).
  const resolvedTarget = path.resolve(target);
  const resolvedDir = path.resolve(destDir);
  if (resolvedTarget !== path.join(resolvedDir, filename) || !resolvedTarget.startsWith(resolvedDir + path.sep)) {
    throw new Error('Chemin de modèle invalide');
  }

  if (!fs.existsSync(resolvedTarget)) {
    throw new Error('Modèle introuvable');
  }
  fs.unlinkSync(resolvedTarget);
  return { ok: true, deleted: filename };
}
