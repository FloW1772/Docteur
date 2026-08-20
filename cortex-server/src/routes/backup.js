import { Hono } from 'hono';
import fs from 'node:fs';
import { listBackups, runBackup } from '../lib/backup.js';
import { savePageToStore, upsertFileOriginal, upsertFileResult, getFileOriginals, getFileResults, getAllPagesFromStore, getTodoItems, addTodoItem } from '../lib/sqlite.js';
import { IMAGE_DIR } from '../lib/image.js';

export function createBackupRoute({ services, logger }) {
  const route = new Hono();

  // GET /api/backup/list — liste des backups disque
  route.get('/backup/list', async (c) => {
    try {
      const backups = listBackups(services.lancedbPath);
      return c.json({ backups, count: backups.length });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/backup/export — dump JSON de tous les neurones
  route.get('/backup/export', async (c) => {
    try {
      const neurons = await services.getAllNeuronsForBackup();

      // Merge links + updatedAt from SQLite pages — LanceDB doesn't store them
      const pages = getAllPagesFromStore();
      const pageMap = new Map(pages.map(p => [p.id, p]));
      const neuronsWithLinks = neurons.map(n => {
        const page = pageMap.get(n.id);
        if (!page) return n;
        const extra = {};
        if (Array.isArray(page.links) && page.links.length > 0) extra.links = page.links;
        if (page.updatedAt) extra.updatedAt = page.updatedAt;
        return Object.keys(extra).length ? { ...n, ...extra } : n;
      });

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
        version: '1.1',
        exported_at: new Date().toISOString(),
        neurons_count: neuronsWithLinks.length,
        neurons: neuronsWithLinks,
        files: {
          originals: getFileOriginals(),
          results: getFileResults(),
        },
        images_note: imageCount > 0
          ? `${imageCount} image(s) (~${Math.round(imagesTotalBytes / 1024 / 1024 * 10) / 10} Mo) stockées dans data/images/ — sauvegarder ce dossier séparément. Les neurones se restaurent sans les images (placeholder affiché).`
          : 'Aucune image dans ce backup.',
        todo_items: getTodoItems(),
      });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/backup/trigger — force un backup fichier maintenant
  route.post('/backup/trigger', async (c) => {
    try {
      const result = await runBackup(services.lancedbPath);
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/backup/import — restauration depuis un JSON
  route.post('/backup/import', async (c) => {
    try {
      const body = await c.req.json();
      if (!body?.version || !Array.isArray(body.neurons)) {
        return c.json({ error: 'Format invalide : champ version ou neurons manquant' }, 400);
      }
      if (body.neurons.length > 100_000) {
        return c.json({ error: `Import refusé : ${body.neurons.length} neurones dépasse la limite de 100 000` }, 400);
      }

      let indexed = 0;
      const errors = [];

      for (const neuron of body.neurons) {
        if (!neuron.id || !neuron.title) continue;
        try {
          await services.indexNeuron({
            id:       neuron.id,
            kind:     neuron.kind ?? 'note',
            title:    neuron.title ?? '',
            content:  neuron.content ?? '',
            metadata: neuron.metadata ?? {},
          });
          // Restore full page content to SQLite so mobile/remote clients can read it
          savePageToStore(neuron);
          indexed++;
        } catch (err) {
          errors.push({ id: neuron.id, title: neuron.title, error: err.message });
          logger?.warn({ id: neuron.id, error: err.message }, 'import neuron failed');
        }
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
            errors.push({ id: file.id, title: file.original_name, error: err.message });
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
            errors.push({ id: file.id, title: file.stored_name ?? file.original_name ?? 'résultat', error: err.message });
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
          } catch { /* skip duplicates */ }
        }
      }

      return c.json({ ok: true, indexed, total: body.neurons.length, restoredFiles, restoredTodos, errors });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return route;
}
