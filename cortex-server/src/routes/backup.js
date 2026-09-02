import { Hono } from 'hono';
import fs from 'node:fs';
import { listBackups, runBackup } from '../lib/backup.js';
import { savePageToStore, upsertFileOriginal, upsertFileResult, getFileOriginals, getFileResults, getAllPagesFromStore, getTodoItems, addTodoItem, getAllConversationsForBackup, listPreferenceFacts, getAllGeneratedPrompts, insertGeneratedPrompt } from '../lib/sqlite.js';
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

      // SQLite `pages` holds the full Page shape (blocks, dates, color, tags,
      // private) — LanceDB only ever stored the flattened id/kind/title/content/
      // metadata used for embedding. Prefer the SQLite page wholesale when one
      // exists so the export round-trips everything the editor actually shows;
      // fall back to the LanceDB-only fields for a neuron with no matching page
      // (e.g. indexed directly via /index without ever being saved).
      const pages = getAllPagesFromStore();
      const pageMap = new Map(pages.map(p => [p.id, p]));
      const neuronsWithLinks = neurons.map(n => {
        const page = pageMap.get(n.id);
        if (!page) return n;
        return {
          id:        page.id,
          kind:      page.kind ?? n.kind,
          title:     page.title ?? n.title,
          content:   n.content, // flattened text used for embedding on re-import
          blocks:    Array.isArray(page.blocks) ? page.blocks : [],
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
          links:     Array.isArray(page.links) ? page.links : [],
          color:     page.color,
          tags:      page.tags,
          metadata:  page.metadata ?? n.metadata ?? {},
          private:   page.private,
        };
      });

      // Build deduplicated edge list from SQLite — client no longer needs in-memory pages for this
      const seenEdges = new Set();
      const links = [];
      for (const page of pages) {
        for (const targetId of (page.links ?? [])) {
          const key = [page.id, targetId].sort().join('|');
          if (!seenEdges.has(key)) { seenEdges.add(key); links.push({ from: page.id, to: targetId }); }
        }
      }

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
        version: '1.2', // 1.2: full Page fidelity (blocks, createdAt, color, tags, private)
        exported_at: new Date().toISOString(),
        neurons_count: neuronsWithLinks.length,
        neurons: neuronsWithLinks,
        links,
        files: {
          originals: getFileOriginals(),
          results: getFileResults(),
        },
        images_note: imageCount > 0
          ? `${imageCount} image(s) (~${Math.round(imagesTotalBytes / 1024 / 1024 * 10) / 10} Mo) stockées dans data/images/ — sauvegarder ce dossier séparément. Les neurones se restaurent sans les images (placeholder affiché).`
          : 'Aucune image dans ce backup.',
        todo_items: getTodoItems(),
        // Clearly labeled as personal — conversations and remembered preferences,
        // unlike neurons, were never meant to be searched/shared. Included here
        // (unlike activity_log, which never leaves the machine) because the user
        // explicitly asked for them to survive a restore, but kept under this
        // dedicated key so a restore path can treat it distinctly if needed.
        personal_data: {
          note: 'Conversations et préférences retenues — données personnelles, jamais indexées ni envoyées au cloud.',
          conversations: getAllConversationsForBackup(),
          preference_facts: listPreferenceFacts(),
        },
        // NOTE: activity_log is intentionally NEVER included here — the journal
        // never leaves this machine, even in an export the user explicitly requested.
        // Générateur de prompts — section distincte, jamais mêlée aux neurones.
        generated_prompts: {
          note: 'Prompts générés (brouillon + relecture croisée) — indépendants des neurones.',
          prompts: getAllGeneratedPrompts({}),
        },
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
      let reconstructedBlocks = 0;
      const errors = [];

      for (const neuron of body.neurons) {
        if (!neuron.id || !neuron.title) continue;
        try {
          const now = Date.now();

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

          await services.indexNeuron({
            id:       page.id,
            kind:     page.kind,
            title:    page.title,
            content:  neuron.content ?? blocks.map(b => b.content).filter(Boolean).join('\n\n'),
            metadata: page.metadata,
          });
          // Restore full page content to SQLite so mobile/remote clients can read it
          savePageToStore(page);
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
          } catch { /* skip duplicates */ }
        }
      }

      return c.json({ ok: true, indexed, total: body.neurons.length, restoredFiles, restoredTodos, reconstructedBlocks, restoredPrompts, errors });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return route;
}
