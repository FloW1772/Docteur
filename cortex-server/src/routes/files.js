import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import {
  getFilesRoot,
  getOriginalsDir,
  getResultsDir,
  ensureFileDirectories,
  buildOriginalStoredName,
  buildResultStoredName,
  checksumBuffer,
  parseOriginalFile,
  buildMarkdownPreview,
  mimeForExtension,
  sanitizeBaseName,
  sanitizeExtension,
  isAllowedFileName,
  formatFileStamp,
} from '../lib/files.js';
import {
  getFileOriginals,
  getFileOriginalById,
  getFileResultsByOriginal,
  getFileResultById,
  upsertFileOriginal,
  deleteFileOriginal,
  upsertFileResult,
  deleteFileResult,
  updateFileOriginalTreatments,
  getFileResults,
  insertActivityLog,
} from '../lib/sqlite.js';

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function deleteIfExists(filePath) {
  try {
    if (fileExists(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function contentDisposition(fileName) {
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename*=UTF-8''${encoded}`;
}

async function readBuffer(filePath) {
  return await fsp.readFile(filePath);
}

async function writeOriginalRecord(rootDir, file, buffer, parsed) {
  const id = crypto.randomUUID();
  const storedName = buildOriginalStoredName(file.name, id);
  const extension = sanitizeExtension(path.extname(file.name));
  const filePath = path.join(getOriginalsDir(rootDir), storedName);
  await fsp.writeFile(filePath, buffer);

  const original = {
    id,
    original_name: sanitizeBaseName(file.name) + extension,
    stored_name: storedName,
    extension,
    mime_type: parsed.mimeType,
    size_bytes: buffer.length,
    uploaded_at: new Date().toISOString(),
    checksum: checksumBuffer(buffer),
    metadata: {
      source: 'upload',
      parsed_kind: parsed.kind,
      original_filename: file.name,
    },
    treatments_count: 0,
  };

  upsertFileOriginal(original);
  return { original, filePath };
}

function getOriginalPath(rootDir, original) {
  return path.join(getOriginalsDir(rootDir), original.stored_name);
}

function getResultPath(rootDir, result) {
  return path.join(getResultsDir(rootDir), result.stored_name);
}

function buildDetail(rootDir, original) {
  const history = getFileResultsByOriginal(original.id).map((result) => ({
    ...result,
    download_url: `/api/files/results/${encodeURIComponent(result.id)}/download`,
  }));

  return {
    original: {
      ...original,
      file_path: getOriginalPath(rootDir, original),
      download_url: `/api/files/originals/${encodeURIComponent(original.id)}/download`,
    },
    history,
  };
}

function competencies() {
  return {
    copier: {
      label: 'Copier en résultat',
      cloud: false,
      async run({ rootDir, original, fileBuffer }) {
        const id = crypto.randomUUID();
        const storedName = buildResultStoredName(original.original_name, 'copie', id);
        const resultPath = path.join(getResultsDir(rootDir), storedName);
        await fsp.writeFile(resultPath, fileBuffer);
        return { id, resultPath, extension: original.extension, mimeType: original.mime_type, kind: 'file' };
      },
    },
    lecture_structurée: {
      label: 'Lecture structurée',
      cloud: false,
      async run({ rootDir, original, fileBuffer }) {
        const parsed = await parseOriginalFile(fileBuffer, original.original_name);
        const text = buildMarkdownPreview(original, parsed);
        const id = crypto.randomUUID();
        const storedName = buildResultStoredName(original.original_name, 'lecture-structuree', id).replace(/\.[^.]+$/, '.md');
        const resultPath = path.join(getResultsDir(rootDir), storedName);
        await fsp.writeFile(resultPath, text, 'utf8');
        return { id, resultPath, extension: '.md', mimeType: 'text/markdown; charset=utf-8', kind: 'text' };
      },
    },
    extraction_texte: {
      label: 'Extraction texte',
      cloud: false,
      async run({ rootDir, original, fileBuffer }) {
        const parsed = await parseOriginalFile(fileBuffer, original.original_name);
        const text = parsed.kind === 'spreadsheet' ? buildMarkdownPreview(original, parsed) : `${String(parsed.text ?? '').trim()}\n`;
        const id = crypto.randomUUID();
        const storedName = buildResultStoredName(original.original_name, 'extraction-texte', id).replace(/\.[^.]+$/, '.txt');
        const resultPath = path.join(getResultsDir(rootDir), storedName);
        await fsp.writeFile(resultPath, text, 'utf8');
        return { id, resultPath, extension: '.txt', mimeType: 'text/plain; charset=utf-8', kind: 'text' };
      },
    },
    cloud_resume: {
      label: 'Résumé cloud',
      cloud: true,
      async run() {
        throw new Error('Cette compétence cloud nécessite une implémentation explicite côté serveur.');
      },
    },
  };
}

export function createFilesRoute({ rootDir, logger } = {}) {
  const route = new Hono();
  ensureFileDirectories(rootDir);

  route.get('/files', (c) => {
    return c.json({
      paths: {
        root: getFilesRoot(rootDir),
        originals: getOriginalsDir(rootDir),
        results: getResultsDir(rootDir),
      },
      originals: getFileOriginals().map((item) => ({
        ...item,
        download_url: `/api/files/originals/${encodeURIComponent(item.id)}/download`,
        detail_url: `/api/files/originals/${encodeURIComponent(item.id)}`,
        results_url: `/api/files/originals/${encodeURIComponent(item.id)}/results`,
      })),
      results: getFileResults().map((item) => ({
        ...item,
        download_url: `/api/files/results/${encodeURIComponent(item.id)}/download`,
        original_detail_url: `/api/files/originals/${encodeURIComponent(item.original_id)}`,
      })),
      competences: Object.entries(competencies()).map(([id, value]) => ({ id, label: value.label, cloud: value.cloud })),
    });
  });

  route.get('/files/originals/:id', async (c) => {
    const original = getFileOriginalById(c.req.param('id'));
    if (!original) return c.json({ error: 'Fichier original introuvable' }, 404);
    try {
      const buffer = await readBuffer(getOriginalPath(rootDir, original));
      const preview = await parseOriginalFile(buffer, original.original_name);
      return c.json({ ...buildDetail(rootDir, original), preview });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  route.get('/files/originals/:id/download', async (c) => {
    const original = getFileOriginalById(c.req.param('id'));
    if (!original) return c.json({ error: 'Fichier original introuvable' }, 404);
    const filePath = getOriginalPath(rootDir, original);
    if (!fileExists(filePath)) return c.json({ error: 'Fichier introuvable sur le disque' }, 404);
    const buffer = await readBuffer(filePath);
    return new Response(buffer, {
      headers: {
        'Content-Type': original.mime_type,
        'Content-Disposition': contentDisposition(original.original_name),
        'Content-Length': String(buffer.length),
      },
    });
  });

  route.post('/files/upload', async (c) => {
    // First filter, BEFORE buffering the multipart body into memory: reject
    // obviously oversized requests using the client-declared Content-Length.
    // This is not authoritative (a client can lie, and multipart framing adds
    // overhead on top of the real file size) — the authoritative check stays
    // below, on the actually-received file.size, as a second filter.
    const declaredLength = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > 20 * 1024 * 1024 + 64 * 1024) {
      return c.json({ error: 'Fichier trop volumineux (max 20 Mo)' }, 413);
    }

    let formData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Formulaire invalide' }, 400);
    }

    const file = formData.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Champ "file" manquant' }, 400);
    }
    if (!isAllowedFileName(file.name)) {
      return c.json({ error: 'Format non supporté. Formats autorisés: .xlsx, .csv, .txt, .md, .json' }, 415);
    }
    if (file.size > 20 * 1024 * 1024) {
      return c.json({ error: 'Fichier trop volumineux (max 20 Mo)' }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const parsed = await parseOriginalFile(buffer, file.name);
      const { original } = await writeOriginalRecord(rootDir, file, buffer, parsed);
      if (logger) logger.info({ originalId: original.id, name: original.original_name, size: original.size_bytes }, 'file uploaded');
      insertActivityLog({ opType: 'file_import', item: original.original_name, result: 'success' });
      return c.json({ ok: true, original, preview_kind: parsed.kind, detail_url: `/api/files/originals/${encodeURIComponent(original.id)}` }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      insertActivityLog({ opType: 'file_import', item: file.name, result: 'failure', reason: message });
      return c.json({ error: message }, 422);
    }
  });

  route.post('/files/originals/:id/process', async (c) => {
    const original = getFileOriginalById(c.req.param('id'));
    if (!original) return c.json({ error: 'Fichier original introuvable' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const competenceId = String(body?.competence ?? 'lecture_structurée').trim();
    const allowCloud = body?.allowCloud === true;
    const competence = competencies()[competenceId];
    if (!competence) return c.json({ error: `Compétence inconnue : ${competenceId}` }, 400);
    if (competence.cloud && !allowCloud) {
      return c.json({
        error: 'Cette compétence enverra le fichier vers un service cloud. Confirmation explicite requise.',
        cloud_required: true,
      }, 412);
    }

    const filePath = getOriginalPath(rootDir, original);
    if (!fileExists(filePath)) return c.json({ error: 'Fichier original introuvable sur le disque' }, 404);

    const fileBuffer = await readBuffer(filePath);
    const createdAt = new Date().toISOString();
    let result = null;

    try {
      result = await competence.run({ rootDir, original, fileBuffer, createdAt });
      const resultSize = (await fsp.stat(result.resultPath)).size;
      const resultRecord = {
        id: result.id,
        original_id: original.id,
        competence: competenceId,
        result_kind: result.kind,
        original_name: original.original_name,
        stored_name: path.basename(result.resultPath),
        extension: result.extension,
        mime_type: result.mimeType,
        size_bytes: resultSize,
        created_at: createdAt,
        checksum: checksumBuffer(await readBuffer(result.resultPath)),
        path: result.resultPath,
        cloud_allowed: allowCloud,
        metadata: {
          source_original_id: original.id,
          source_original_name: original.original_name,
          competence: competenceId,
          cloud_allowed: allowCloud,
        },
      };

      upsertFileResult(resultRecord);
      updateFileOriginalTreatments(original.id, (original.treatments_count ?? 0) + 1);
      if (logger) logger.info({ originalId: original.id, resultId: resultRecord.id, competence: competenceId }, 'file processed');
      return c.json({ ok: true, result: resultRecord });
    } catch (error) {
      if (result?.resultPath) deleteIfExists(result.resultPath);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  route.get('/files/results/:id/download', async (c) => {
    const result = getFileResultById(c.req.param('id'));
    if (!result) return c.json({ error: 'Résultat introuvable' }, 404);
    if (!fileExists(result.path)) return c.json({ error: 'Fichier résultat introuvable sur le disque' }, 404);
    const buffer = await readBuffer(result.path);
    return new Response(buffer, {
      headers: {
        'Content-Type': result.mime_type,
        'Content-Disposition': contentDisposition(result.stored_name),
        'Content-Length': String(buffer.length),
      },
    });
  });

  route.post('/files/results/:id/restore', async (c) => {
    const result = getFileResultById(c.req.param('id'));
    if (!result) return c.json({ error: 'Résultat introuvable' }, 404);
    if (!fileExists(result.path)) return c.json({ error: 'Fichier résultat introuvable sur le disque' }, 404);

    const sourceOriginal = getFileOriginalById(result.original_id);
    if (!sourceOriginal) return c.json({ error: 'Original source introuvable' }, 404);

    const newId = crypto.randomUUID();
    const extension = sanitizeExtension(path.extname(result.stored_name || sourceOriginal.original_name));
    const restoredName = `${sanitizeBaseName(sourceOriginal.original_name)}_restaure_${formatFileStamp(new Date())}_${newId}${extension}`;
    const targetPath = path.join(getOriginalsDir(rootDir), restoredName);
    await fsp.copyFile(result.path, targetPath);

    const buffer = await readBuffer(targetPath);
    const restoredOriginal = {
      id: newId,
      original_name: restoredName,
      stored_name: restoredName,
      extension,
      mime_type: result.mime_type,
      size_bytes: buffer.length,
      uploaded_at: new Date().toISOString(),
      checksum: checksumBuffer(buffer),
      metadata: {
        restored_from_result_id: result.id,
        source_original_id: result.original_id,
        source_result_name: result.stored_name,
      },
      treatments_count: 0,
    };

    upsertFileOriginal(restoredOriginal);
    return c.json({ ok: true, original: restoredOriginal });
  });

  route.delete('/files/results/:id', async (c) => {
    const result = getFileResultById(c.req.param('id'));
    if (!result) return c.json({ error: 'Résultat introuvable' }, 404);
    deleteIfExists(result.path);
    deleteFileResult(result.id);
    const original = getFileOriginalById(result.original_id);
    if (original) {
      updateFileOriginalTreatments(original.id, Math.max(0, (original.treatments_count ?? 1) - 1));
    }
    return c.json({ ok: true });
  });

  route.delete('/files/originals/:id', async (c) => {
    const original = getFileOriginalById(c.req.param('id'));
    if (!original) return c.json({ error: 'Fichier original introuvable' }, 404);
    const deleteResults = c.req.query('deleteResults') === 'true';
    const results = getFileResultsByOriginal(original.id);
    if (results.length > 0 && !deleteResults) {
      return c.json({ error: `Ce fichier possède ${results.length} résultat(s). Confirme la suppression avec deleteResults=true.`, result_count: results.length }, 409);
    }

    for (const result of results) {
      deleteIfExists(result.path);
      deleteFileResult(result.id);
    }
    deleteIfExists(getOriginalPath(rootDir, original));
    deleteFileOriginal(original.id);
    return c.json({ ok: true, deleted_results: results.length });
  });

  route.get('/files/originals/:id/results', (c) => {
    const original = getFileOriginalById(c.req.param('id'));
    if (!original) return c.json({ error: 'Fichier original introuvable' }, 404);
    return c.json({ original_id: original.id, results: getFileResultsByOriginal(original.id) });
  });

  return route;
}