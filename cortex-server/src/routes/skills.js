import { Hono } from 'hono';
import {
  getAllSkills, getSkillById, countSkills,
  insertSkill, updateSkill, deleteSkill,
  insertSkillRun, updateSkillRun, getSkillRuns, bumpSkillRunCount,
} from '../lib/sqlite.js';
import { getRouterSettings } from '../lib/sqlite.js';
import { parseIntParam } from '../lib/http-params.js';

const MAX_SKILLS         = 30;
const MAX_INPUT_CHARS    = 12_000;
const MAX_CONTEXT_CHARS  = 8_000;

// ── Guardrails ────────────────────────────────────────────────────────────────

function resolveModel(skill, services) {
  const { strict_local_mode } = getRouterSettings();
  // Private skill → always local
  // Strict local mode → always local
  if (skill.private || strict_local_mode) return 'local';
  return skill.model ?? 'local';
}

async function runWithModel(model, messages, services) {
  if (model === 'local') {
    return services.runLocalStandard(messages);
  }
  // Cloud path is not implemented yet. The UI lets a non-private skill be
  // marked "cloud" and even warns the user "le contenu sera envoyé au
  // fournisseur cloud" — silently falling back to the local model here would
  // make that warning false and mislead the user about where their data goes.
  // Fail loudly instead until a real cloud provider path is wired.
  throw Object.assign(
    new Error('Exécution cloud non implémentée pour les compétences — repasse cette compétence en local dans ses réglages.'),
    { cloud_not_implemented: true },
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function createSkillsRoute({ services, logger }) {
  const route = new Hono();

  // ── GET /skills — list all ─────────────────────────────────────────────────
  route.get('/skills', (c) => {
    return c.json({ skills: getAllSkills(), count: countSkills(), max: MAX_SKILLS });
  });

  // ── POST /skills — create ──────────────────────────────────────────────────
  route.post('/skills', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.name?.trim()) return c.json({ error: 'name requis' }, 400);
    if (countSkills() >= MAX_SKILLS) return c.json({ error: `Limite de ${MAX_SKILLS} compétences atteinte` }, 409);

    const { strict_local_mode } = getRouterSettings();
    const model = (body.private || strict_local_mode) ? 'local' : (body.model ?? 'local');

    const id = crypto.randomUUID();
    insertSkill({
      id,
      name:        String(body.name).trim().slice(0, 80),
      description: String(body.description ?? '').trim().slice(0, 300),
      instruction: String(body.instruction ?? '').trim(),
      input_type:  body.input_type  ?? 'text',
      output_type: body.output_type ?? 'display',
      output_kind: body.output_kind ?? 'note',
      model,
      private:     !!body.private,
    });

    return c.json({ skill: getSkillById(id) }, 201);
  });

  // ── PUT /skills/:id — update ───────────────────────────────────────────────
  route.put('/skills/:id', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'body requis' }, 400);

    const existing = getSkillById(id);
    if (!existing) return c.json({ error: 'Compétence introuvable' }, 404);

    const { strict_local_mode } = getRouterSettings();
    const updates = {};
    if (body.name        !== undefined) updates.name        = String(body.name).trim().slice(0, 80);
    if (body.description !== undefined) updates.description = String(body.description).trim().slice(0, 300);
    if (body.instruction !== undefined) updates.instruction = String(body.instruction).trim();
    if (body.input_type  !== undefined) updates.input_type  = body.input_type;
    if (body.output_type !== undefined) updates.output_type = body.output_type;
    if (body.output_kind !== undefined) updates.output_kind = body.output_kind;
    if (body.private     !== undefined) updates.private     = !!body.private;
    if (body.active      !== undefined) updates.active      = !!body.active;
    if (body.model       !== undefined) {
      const isPrivate = body.private !== undefined ? !!body.private : existing.private;
      updates.model = (isPrivate || strict_local_mode) ? 'local' : body.model;
    }

    updateSkill(id, updates);
    return c.json({ skill: getSkillById(id) });
  });

  // ── DELETE /skills/:id ─────────────────────────────────────────────────────
  route.delete('/skills/:id', (c) => {
    const id = c.req.param('id');
    if (!getSkillById(id)) return c.json({ error: 'Compétence introuvable' }, 404);
    deleteSkill(id);
    return c.json({ ok: true });
  });

  // ── POST /skills/generate — generate instruction from natural language ──────
  route.post('/skills/generate', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.description?.trim()) return c.json({ error: 'description requise' }, 400);

    const description = String(body.description).trim().slice(0, 500);
    const example     = body.example ? String(body.example).trim().slice(0, 500) : null;

    const messages = [
      {
        role: 'system',
        content:
          'Tu es un assistant expert en conception de prompts. ' +
          'À partir d\'une description en langage naturel d\'un traitement à appliquer à du texte, ' +
          'génère une INSTRUCTION de prompt claire, précise et réutilisable. ' +
          'L\'instruction sera appliquée à un contenu fourni par l\'utilisateur. ' +
          'Réponds UNIQUEMENT avec l\'instruction, sans explication, sans balises, sans préambule. ' +
          'Commence directement par l\'impératif (ex: "Transforme...", "Extrais...", "Résume...", "Analyse..."). ' +
          'L\'instruction doit être autonome, générique, et fonctionner sur n\'importe quel contenu du type décrit.',
      },
      {
        role: 'user',
        content: `Description du besoin : ${description}${example ? `\n\nExemple de contenu à traiter :\n${example}` : ''}`,
      },
    ];

    try {
      const result = await services.runLocalStandard(messages);
      // Also suggest a name
      const nameMessages = [
        { role: 'system', content: 'Génère un nom court (2-4 mots maximum) pour cette compétence. Réponds UNIQUEMENT avec le nom, sans ponctuation ni explication.' },
        { role: 'user', content: `Compétence : ${description}` },
      ];
      let suggestedName = description.slice(0, 50);
      try {
        const nr = await services.runLocalStandard(nameMessages);
        suggestedName = nr.text.trim().slice(0, 80);
      } catch { /* fallback */ }

      return c.json({ instruction: result.text.trim(), suggested_name: suggestedName, model_used: result.model });
    } catch (err) {
      logger?.warn({ err: err.message }, 'skills: generate failed');
      return c.json({ error: `Modèle local indisponible : ${err.message}` }, 503);
    }
  });

  // ── POST /skills/:id/refine — refine instruction from feedback ─────────────
  route.post('/skills/:id/refine', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body?.feedback?.trim()) return c.json({ error: 'feedback requis' }, 400);

    const skill = getSkillById(id);
    if (!skill) return c.json({ error: 'Compétence introuvable' }, 404);

    const feedback    = String(body.feedback).trim().slice(0, 500);
    const badOutput   = body.bad_output ? String(body.bad_output).trim().slice(0, 500) : null;

    const messages = [
      {
        role: 'system',
        content:
          'Tu es un assistant expert en amélioration de prompts. ' +
          'Améliore l\'instruction ci-dessous en tenant compte du retour utilisateur. ' +
          'Réponds UNIQUEMENT avec la nouvelle instruction, sans explication ni balise.',
      },
      {
        role: 'user',
        content:
          `Instruction actuelle :\n${skill.instruction}` +
          (badOutput ? `\n\nRésultat décevant obtenu :\n${badOutput}` : '') +
          `\n\nCe qui n'allait pas / amélioration souhaitée :\n${feedback}`,
      },
    ];

    try {
      const result = await services.runLocalStandard(messages);
      return c.json({ instruction: result.text.trim(), model_used: result.model });
    } catch (err) {
      logger?.warn({ err: err.message }, 'skills: refine failed');
      return c.json({ error: `Modèle local indisponible : ${err.message}` }, 503);
    }
  });

  // ── POST /skills/:id/run — execute skill on input ──────────────────────────
  route.post('/skills/:id/run', async (c) => {
    const id   = c.req.param('id');
    const body = await c.req.json().catch(() => null);

    const skill = getSkillById(id);
    if (!skill) return c.json({ error: 'Compétence introuvable' }, 404);
    if (!skill.active) return c.json({ error: 'Compétence désactivée' }, 409);
    if (!skill.instruction?.trim()) return c.json({ error: 'Compétence sans instruction' }, 422);

    const rawInput = String(body?.input ?? '').trim();
    if (!rawInput) return c.json({ error: 'input requis' }, 400);

    const input  = rawInput.slice(0, MAX_INPUT_CHARS);
    const runId  = crypto.randomUUID();
    const now    = new Date().toISOString();

    insertSkillRun({ id: runId, skill_id: id, input_preview: input.slice(0, 300), started_at: now });

    const model = resolveModel(skill, services);

    const messages = [
      {
        role: 'system',
        content:
          `Tu es un assistant qui applique fidèlement des instructions de traitement de texte. ` +
          `Applique l'instruction suivante au contenu fourni. ` +
          `Réponds directement avec le résultat, sans commentaire sur l'instruction elle-même.\n\n` +
          `INSTRUCTION :\n${skill.instruction}`,
      },
      { role: 'user', content: `CONTENU À TRAITER :\n${input}` },
    ];

    const t0 = Date.now();
    try {
      const result = await runWithModel(model, messages, services);
      const latency = Date.now() - t0;
      updateSkillRun(runId, {
        output:      result.text.trim(),
        model_used:  result.model,
        latency_ms:  latency,
        finished_at: new Date().toISOString(),
        status:      'done',
      });
      bumpSkillRunCount(id);
      return c.json({ run_id: runId, output: result.text.trim(), model_used: result.model, latency_ms: latency });
    } catch (err) {
      logger?.warn({ err: err.message, skill_id: id }, 'skills: run failed');
      updateSkillRun(runId, {
        finished_at:   new Date().toISOString(),
        status:        'error',
        error_message: err.message,
      });
      return c.json({ error: `Exécution échouée : ${err.message}` }, 503);
    }
  });

  // ── GET /skills/:id/runs — history ─────────────────────────────────────────
  route.get('/skills/:id/runs', (c) => {
    const id = c.req.param('id');
    if (!getSkillById(id)) return c.json({ error: 'Compétence introuvable' }, 404);
    const limit = Math.min(parseIntParam(c.req.query('limit'), 30), 100);
    return c.json({ runs: getSkillRuns(id, limit) });
  });

  // ── GET /skills/export/:id — export as JSON ────────────────────────────────
  route.get('/skills/export/:id', (c) => {
    const skill = getSkillById(c.req.param('id'));
    if (!skill) return c.json({ error: 'Compétence introuvable' }, 404);
    const exported = {
      __docteur_skill_version: 1,
      name:        skill.name,
      description: skill.description,
      instruction: skill.instruction,
      input_type:  skill.input_type,
      output_type: skill.output_type,
      output_kind: skill.output_kind,
      model:       skill.model,
      private:     skill.private,
    };
    return new Response(JSON.stringify(exported, null, 2), {
      headers: {
        'Content-Type':        'application/json',
        'Content-Disposition': `attachment; filename="skill-${skill.name.replace(/[^a-z0-9]/gi, '-')}.json"`,
      },
    });
  });

  // ── POST /skills/import — import from JSON ─────────────────────────────────
  route.post('/skills/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || body.__docteur_skill_version !== 1) {
      return c.json({ error: 'Format invalide — fichier JSON de compétence Docteur attendu' }, 400);
    }
    if (!body.name?.trim()) return c.json({ error: 'name manquant dans le fichier' }, 400);
    if (countSkills() >= MAX_SKILLS) return c.json({ error: `Limite de ${MAX_SKILLS} compétences atteinte` }, 409);

    const { strict_local_mode } = getRouterSettings();
    const id = crypto.randomUUID();
    insertSkill({
      id,
      name:        String(body.name).trim().slice(0, 80),
      description: String(body.description ?? '').trim().slice(0, 300),
      instruction: String(body.instruction ?? '').trim(),
      input_type:  body.input_type  ?? 'text',
      output_type: body.output_type ?? 'display',
      output_kind: body.output_kind ?? 'note',
      model:       (body.private || strict_local_mode) ? 'local' : (body.model ?? 'local'),
      private:     !!body.private,
    });

    return c.json({ skill: getSkillById(id) }, 201);
  });

  return route;
}
