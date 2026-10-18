import { Hono } from 'hono';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { listBackups, runBackup } from '../lib/backup.js';
import { buildBackupSnapshot, restoreBackupConversation, restoreBackupPreference, validateBackupPage } from '../lib/backup-snapshot.js';
import { savePageToStore, upsertFileOriginal, upsertFileResult, addTodoItem, insertGeneratedPrompt } from '../lib/sqlite.js';
import { IMAGE_DIR } from '../lib/image.js';
import { PublicError, publicErrorBody, publicErrorMessage, safeErrorLogFields } from '../lib/safe-error-contract.js'; // [SEC-REMED-4B]

// [SEC-REMED-4B] Error text from a runtime / provider / subprocess / store is untrusted: the client gets a stable
// code + this fixed text (a PublicError keeps its own Docteur-written message).
const BACKUP_FAILED = { code: 'BACKUP_OPERATION_FAILED', message: 'Opération de sauvegarde impossible.' };

export function createBackupRoute({ services, logger }) {
  const route = new Hono();

  // GET /api/backup/list — liste des backups disque
  route.get('/backup/list', async (c) => {
    try {
      const backups = listBackups(services.lancedbPath);
      return c.json({ backups, count: backups.length });
    } catch (error) {
      return c.json(publicErrorBody(error, BACKUP_FAILED), 500);
    }
  });

  // GET /api/backup/export — dump JSON de tous les neurones
  route.get('/backup/export', async (c) => {
    try {
      const neurons = await services.getAllNeuronsForBackup();

      const snapshot = buildBackupSnapshot(neurons);

      // Count images on disk for the export manifest
      let imageCount = 0;
      let imagesTotalBytes = 0;
      try {
        for (const f of fs.readdirSync(IMAGE_DIR)) {
          const stat = fs.statSync(`${IMAGE_DIR}/${f}`);
          if (stat.isFile()) { imageCount++; imagesTotalBytes += stat.size; }
        }
      } catch { /* images dir may not exist */ }

      // Images are NOT embedded in this JSON — they live in data/images/ on disk.
      // To restore images, copy data/images/ alongside this file before importing.
      return c.json({
        ...snapshot,
        images_note: imageCount > 0
          ? `${imageCount} image(s) (~${Math.round(imagesTotalBytes / 1024 / 1024 * 10) / 10} Mo) stockées dans data/images/ — sauvegarder ce dossier séparément. Les neurones se restaurent sans les images (placeholder affiché).`
          : 'Aucune image dans ce backup.',
      });
    } catch (error) {
      return c.json(publicErrorBody(error, BACKUP_FAILED), 500);
    }
  });

  // POST /api/backup/trigger — force un backup fichier maintenant
  route.post('/backup/trigger', async (c) => {
    try {
      const result = await runBackup(services.lancedbPath);
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json(publicErrorBody(error, BACKUP_FAILED), 500);
    }
  });

  // POST /api/backup/import — restauration depuis un JSON
  route.post('/backup/import', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body?.version || !Array.isArray(body.neurons)) {
        return c.json({ error: 'Format invalide : champ version ou neurons manquant' }, 400);
      }
      if (body.neurons.length > 100_000) {
        return c.json({ error: `Import refusé : ${body.neurons.length} neurones dépasse la limite de 100 000` }, 400);
      }

      let indexed = 0;
      let saved = 0;
      let reconstructedBlocks = 0;
      const errors = [];

      for (const neuron of body.neurons) {
        if (!neuron || typeof neuron.id !== 'string' || !neuron.id || typeof neuron.title !== 'string') {
          errors.push({ id: neuron?.id ?? '', title: '', error: 'Neurone invalide' });
          continue;
        }
        try {
          const now = Date.now();
          if (neuron.blocks !== undefined && !Array.isArray(neuron.blocks)) throw new PublicError('INVALID_BACKUP_ITEM', 'Blocs du neurone invalides');
          if (neuron.content !== undefined && typeof neuron.content !== 'string') throw new PublicError('INVALID_BACKUP_ITEM', 'Contenu du neurone invalide');
          if (neuron.links !== undefined && !Array.isArray(neuron.links)) throw new PublicError('INVALID_BACKUP_ITEM', 'Liens du neurone invalides');

          // Older backups (pre-1.2) never exported `blocks` — rebuild a single
          // paragraph block from the flattened `content` so the restored
          // neuron isn't blank in the editor, and count it so the response
          // can tell the user which neurons got a reconstructed body.
          let blocks = Array.isArray(neuron.blocks) ? neuron.blocks : null;
          if (!blocks) {
            const text = String(neuron.content ?? '').trim();
            blocks = text ? [{ id: crypto.randomUUID(), type: 'paragraph', content: text }] : [];
            if (blocks.length > 0) reconstructedBlocks++;
          }

          const page = {
            id:        neuron.id,
            title:     neuron.title ?? '',
            kind:      neuron.kind ?? 'note',
            blocks,
            createdAt: neuron.createdAt ?? neuron.updatedAt ?? now,
            updatedAt: neuron.updatedAt ?? now,
            links:     Array.isArray(neuron.links) ? neuron.links : undefined,
            color:     neuron.color,
            tags:      neuron.tags,
            metadata:  neuron.metadata ?? {},
            private:   neuron.private,
          };
          validateBackupPage(page);

          // Original data must survive even if Ollama or the vector index is
          // unavailable. Indexing is derived data, independent from restoration.
          savePageToStore(page);
          saved++;
          await services.indexNeuron({
            id:       page.id,
            kind:     page.kind,
            title:    page.title,
            content:  neuron.content ?? blocks.map(b => b.content).filter(Boolean).join('\n\n'),
            metadata: page.metadata,
            private: page.private,
          });
          indexed++;
        } catch (err) {
          errors.push({ id: neuron.id, title: neuron.title, error: publicErrorMessage(err, 'Élément non restauré.') });
          logger?.warn({ id: neuron.id, ...safeErrorLogFields(err, { operation: 'route.backup' }) }, 'import neuron failed');
        }
      }

      let restoredConversations = 0;
      let restoredPreferences = 0;
      for (const conversation of (Array.isArray(body.personal_data?.conversations) ? body.personal_data.conversations : [])) {
        try { if (restoreBackupConversation(conversation)) restoredConversations++; }
        catch (err) { errors.push({ id: conversation?.id ?? '', title: 'Conversation', error: publicErrorMessage(err, 'Élément non restauré.') }); }
      }
      for (const fact of (Array.isArray(body.personal_data?.preference_facts) ? body.personal_data.preference_facts : [])) {
        try { if (restoreBackupPreference(fact)) restoredPreferences++; }
        catch (err) { errors.push({ id: fact?.id ?? '', title: 'Préférence', error: publicErrorMessage(err, 'Élément non restauré.') }); }
      }

      let restoredFiles = 0;
      const fileManifest = body.files ?? {};
      if (Array.isArray(fileManifest.originals)) {
        for (const file of fileManifest.originals) {
          if (!file?.id || !file?.original_name) continue;
          try {
            upsertFileOriginal(file);
            restoredFiles++;
          } catch (err) {
            errors.push({ id: file.id, title: file.original_name, error: publicErrorMessage(err, 'Élément non restauré.') });
          }
        }
      }
      if (Array.isArray(fileManifest.results)) {
        for (const file of fileManifest.results) {
          if (!file?.id || !file?.original_id) continue;
          try {
            upsertFileResult(file);
            restoredFiles++;
          } catch (err) {
            errors.push({ id: file.id, title: file.stored_name ?? file.original_name ?? 'résultat', error: publicErrorMessage(err, 'Élément non restauré.') });
          }
        }
      }

      let restoredTodos = 0;
      if (Array.isArray(body.todo_items)) {
        for (const item of body.todo_items) {
          if (!item?.id || !item?.type) continue;
          try {
            addTodoItem(item);
            restoredTodos++;
          } catch (err) {
            if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') errors.push({ id: item.id, title: item.title ?? 'À faire', error: publicErrorMessage(err, 'Élément non restauré.') });
          }
        }
      }

      let restoredPrompts = 0;
      const promptList = body.generated_prompts?.prompts;
      if (Array.isArray(promptList)) {
        for (const p of promptList) {
          if (!p?.request || !p?.draft_text) continue;
          try {
            insertGeneratedPrompt({
              id: p.id ?? crypto.randomUUID(),
              request: p.request,
              draft_model: p.draft_model ?? 'inconnu',
              draft_provider: p.draft_provider ?? 'local',
              draft_text: p.draft_text ?? '',
              review_model: p.review_model ?? 'inconnu',
              review_provider: p.review_provider ?? 'local',
              reviewed_text: p.reviewed_text ?? '',
              changes_explained: p.changes_explained ?? '',
              unchanged: !!p.unchanged,
              kept_version: p.kept_version ?? null,
              outcome: p.outcome ?? 'untested',
              is_template: !!p.is_template,
            });
            restoredPrompts++;
          } catch (err) {
            if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') errors.push({ id: p.id ?? '', title: 'Prompt', error: publicErrorMessage(err, 'Élément non restauré.') });
          }
        }
      }

      return c.json({ ok: errors.length === 0, saved, indexed, index_pending: saved - indexed, total: body.neurons.length, restoredFiles, restoredTodos, reconstructedBlocks, restoredPrompts, restoredConversations, restoredPreferences, errors });
    } catch (error) {
      return c.json(publicErrorBody(error, BACKUP_FAILED), 500);
    }
  });

  return route;
}
