import { Hono }                             from 'hono';
import { getPageFromStore, getAllPagesFromStore, getCloudKeys, getRouterSettings } from '../lib/sqlite.js';
import { buildNeuronHtml, buildSubjectHtml, generatePdf } from '../lib/pdf.js';
import * as groqProvider                      from '../lib/providers/groq.js';
import { completeWithCascade as geminiCascade } from '../lib/providers/gemini.js';
import * as openrouterProvider                from '../lib/providers/openrouter.js';
import * as anthropicProvider                 from '../lib/providers/anthropic.js';
import * as openaiProvider                    from '../lib/providers/openai.js';

const MAX_NEURONS = 20;

// ── Sanitise filename ──────────────────────────────────────────────────────────

function safeFilename(str) {
  return String(str ?? 'export')
    .replace(/[^\wÀ-ɏ一-龥 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80)
    || 'export';
}

// ── Cloud intro generation (complete mode subject) ────────────────────────────

const AUTO_PRIVATE_KINDS = new Set(['cv', 'candidature']);

function isNeuronPrivate(n) {
  if (AUTO_PRIVATE_KINDS.has(n.kind)) return true;
  try { return getPageFromStore(n.id)?.private === true; } catch { return false; }
}

async function tryIntroGeneration(subject, neuronSummaries, logger) {
  const keys     = getCloudKeys();
  const settings = getRouterSettings();

  // Mode local strict → ne jamais appeler le cloud
  if (settings?.strict_local_mode === true) return null;

  // Exclure les neurones privés du contexte envoyé au cloud
  const publicNeurons = neuronSummaries.filter(n => !isNeuronPrivate(n));
  if (publicNeurons.length === 0) return null;

  const summaryText = publicNeurons
    .slice(0, 10)
    .map((n, i) => `${i + 1}. "${n.title}": ${String(n.content ?? '').slice(0, 300)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: 'Tu es un assistant qui rédige des introductions synthétiques en français. Rédige 2-3 paragraphes concis qui présentent le sujet, les grands thèmes abordés dans les sources ci-dessous, et leur intérêt. Style clair et informatif, Markdown simple.',
    },
    {
      role: 'user',
      content: `Sujet : "${subject}"\n\nSources disponibles :\n${summaryText}\n\nRédige une introduction synthétique pour un document PDF sur ce sujet.`,
    },
  ];

  // Note: providers array references `messages` before it's defined above —
  // rebuild with correct reference after messages is defined.
  const providersWithMessages = [];
  if (keys.groq_key)       providersWithMessages.push({ id: 'groq',       call: () => groqProvider.complete({ apiKey: keys.groq_key, messages, model: settings?.groq_model }) });
  if (keys.gemini_key)     providersWithMessages.push({ id: 'gemini',     call: () => geminiCascade({ apiKey: keys.gemini_key, messages, logger }) });
  if (keys.openrouter_key) providersWithMessages.push({ id: 'openrouter', call: () => openrouterProvider.complete({ apiKey: keys.openrouter_key, messages }) });
  if (settings?.paying_apis_enabled) {
    if (keys.anthropic_key) providersWithMessages.push({ id: 'anthropic', call: () => anthropicProvider.complete({ apiKey: keys.anthropic_key, messages }) });
    if (keys.openai_key)    providersWithMessages.push({ id: 'openai',    call: () => openaiProvider.complete({ apiKey: keys.openai_key, messages }) });
  }

  for (const p of providersWithMessages) {
    try {
      const r = await p.call();
      return r.text?.trim() ?? null;
    } catch (err) {
      if (logger) logger.warn({ provider: p.id, error: err.message }, 'PDF: intro provider failed');
    }
  }
  return null;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createPdfRoute({ services, logger } = {}) {
  const route = new Hono();

  // POST /api/pdf/neuron — export a single neuron as PDF
  route.post('/pdf/neuron', async (c) => {
    const body = await c.req.json().catch(() => null);
    const id   = typeof body?.id === 'string' ? body.id.trim() : '';
    const mode = body?.mode === 'complete' ? 'complete' : 'basic';

    if (!id) return c.json({ error: 'id requis' }, 400);

    const page = getPageFromStore(id);
    if (!page) return c.json({ error: 'Neurone introuvable' }, 404);

    // Linked pages (synapses) — included in complete mode only
    let linkedPages = [];
    if (mode === 'complete' && Array.isArray(page.links) && page.links.length > 0) {
      const allPages = getAllPagesFromStore();
      const pagesById = Object.fromEntries(allPages.map(p => [p.id, p]));
      linkedPages = page.links.map(lid => pagesById[lid]).filter(Boolean);
    }

    let pdfBuf;
    try {
      const html = buildNeuronHtml(page, linkedPages, mode);
      pdfBuf = await generatePdf(html, { mode });
    } catch (err) {
      if (logger) logger.error({ error: err.message }, 'PDF: neuron generation failed');
      return c.json({ error: `Échec de la génération PDF : ${err.message}` }, 500);
    }

    const filename = `${safeFilename(page.title)}_${new Date().toISOString().slice(0, 10)}.pdf`;
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(pdfBuf);
  });

  // POST /api/pdf/subject — export a subject synthesis as PDF
  route.post('/pdf/subject', async (c) => {
    const body    = await c.req.json().catch(() => null);
    const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
    const mode    = body?.mode === 'complete' ? 'complete' : 'basic';

    if (!subject) return c.json({ error: 'subject requis' }, 400);

    // Semantic search for relevant neurons
    let rawNeurons = [];
    try {
      const vector = await services.embedText(subject);
      const hits   = await services.searchVector(vector, { limit: MAX_NEURONS + 5, threshold: 0.15 });
      rawNeurons   = hits;
    } catch (err) {
      if (logger) logger.error({ error: err.message }, 'PDF: search failed');
      return c.json({ error: `Recherche impossible : ${err.message}` }, 500);
    }

    const truncated = rawNeurons.length > MAX_NEURONS;
    const neurons   = rawNeurons.slice(0, MAX_NEURONS);

    if (neurons.length === 0) {
      return c.json({ error: 'Aucun neurone trouvé pour ce sujet' }, 404);
    }

    // For complete mode: get full content for each neuron from SQLite pages store
    // (LanceDB search results have content_preview, not full content)
    let neuronsWithContent = neurons;
    try {
      const allPages  = getAllPagesFromStore();
      const pagesById = Object.fromEntries(allPages.map(p => [p.id, p]));
      neuronsWithContent = neurons.map(n => {
        const page = pagesById[n.id];
        if (!page) return n; // fallback to search result
        // Build full text content from blocks
        const content = (page.blocks ?? [])
          .map(b => {
            if (b.type === 'h1') return `## ${b.content}`;
            if (b.type === 'h2') return `### ${b.content}`;
            if (b.type === 'list') return `- ${b.content}`;
            if (b.type === 'todo') return `- [${b.checked ? 'x' : ' '}] ${b.content}`;
            if (b.type === 'image') return '';
            return b.content ?? '';
          })
          .filter(Boolean)
          .join('\n\n');
        return {
          id:       n.id,
          title:    page.title || n.title,
          kind:     page.kind  || n.kind,
          content,
          metadata: page.metadata ?? {},
        };
      });
    } catch {
      // Non-fatal — fall back to LanceDB content_preview
    }

    // AI-generated intro for complete mode
    let intro = null;
    if (mode === 'complete') {
      try {
        intro = await tryIntroGeneration(subject, neuronsWithContent, logger);
      } catch {
        // Non-fatal
      }
    }

    let pdfBuf;
    try {
      const html = buildSubjectHtml(subject, neuronsWithContent, intro, mode, truncated);
      pdfBuf = await generatePdf(html, { mode });
    } catch (err) {
      if (logger) logger.error({ error: err.message }, 'PDF: subject generation failed');
      return c.json({ error: `Échec de la génération PDF : ${err.message}` }, 500);
    }

    const filename = `${safeFilename(subject)}_${new Date().toISOString().slice(0, 10)}.pdf`;
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(pdfBuf);
  });

  return route;
}
