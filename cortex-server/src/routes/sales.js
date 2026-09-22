import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { searchDuckDuckGo } from '../lib/web-search.js';
import { extractContent } from '../lib/deep-capture.js';
import { assertSafeUrl } from '../lib/url-security.js';
import {
  authorizeAction, validateLeadName, validateOptionalText, validateCriteria, wrapUntrustedContent, denied,
} from '../lib/sales-policy.js';
import * as db from '../lib/sqlite.js';
import { scoreLead } from '../lib/sales-scoring.js';
import { draftOutreachMessage, draftCrmNote } from '../lib/sales-draft.js';

// Business/Sales Agent V1 — RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN
// REVIEW only. This file never sends an email, never writes to a real
// CRM, never logs into a browser, never submits a form, never purchases
// anything, and never runs a shell command. Every draft produced here is
// local text, explicitly labeled "DRAFT — NOT SENT", returned to the
// caller for human review — nothing is dispatched anywhere.

const MAX_RESEARCH_PAGES = 3;
const PAGE_TIMEOUT_MS = 10_000;

export function createSalesRoute({
  services, logger,
  search = searchDuckDuckGo, fetchContent = extractContent, checkUrl = assertSafeUrl,
} = {}) {
  const route = new Hono();

  // ── Explicit rejection of any forbidden-action route shape a client
  // might try, mirroring investment.js's real-buy/real-sell/live-order
  // pattern — named and refused, not just absent. ──
  route.post('/sales/leads/:id/send', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/send-email', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/crm-write', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/submit-form', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/purchase', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/browser-login', (c) => c.json({ error: 'forbidden_action_denied' }, 403));
  route.post('/sales/leads/:id/social-post', (c) => c.json({ error: 'forbidden_action_denied' }, 403));

  // ── createLead(name, company) ──
  route.post('/sales/leads', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let name;
    try {
      name = validateLeadName(body.name);
    } catch (err) { return c.json({ error: err.code }, 400); }

    let company, notes;
    try {
      company = validateOptionalText(body.company, 'company_invalid', 200);
      notes = validateOptionalText(body.notes, 'notes_invalid', 2000);
    } catch (err) { return c.json({ error: err.code }, 400); }

    const id = randomUUID();
    db.insertSalesLead({ id, name, company, notes });
    return c.json({ ok: true, id, name, company }, 201);
  });

  route.get('/sales/leads', (c) => c.json({ ok: true, leads: db.getAllSalesLeads() }));

  route.get('/sales/leads/:id', (c) => {
    const lead = db.getSalesLeadById(c.req.param('id'));
    if (!lead) return c.json({ error: 'lead_not_found' }, 404);
    const sources = db.getSalesResearchSourcesForLead(lead.id);
    const drafts = db.getSalesDraftsForLead(lead.id);
    return c.json({ ok: true, lead, sources, drafts });
  });

  // ── RESEARCH — web search + single-page extraction, provenance-tracked,
  // every source wrapped untrusted:true before storage. Same shape as
  // investment.js's POST /investment/research. ──
  route.post('/sales/leads/:id/research', async (c) => {
    const leadId = c.req.param('id');
    const lead = db.getSalesLeadById(leadId);
    if (!lead) return c.json({ error: 'lead_not_found' }, 404);

    try { authorizeAction('RESEARCH'); } catch (err) { return c.json({ error: err.code }, 403); }

    const query = `${lead.name} ${lead.company}`.trim();
    let ddgResults;
    try {
      ddgResults = await search(query);
    } catch (err) {
      logger?.warn?.({ leadId, error_message: err.message }, 'SALES_RESEARCH_SEARCH_FAILED');
      return c.json({ error: 'search_unavailable' }, 503);
    }

    const toFetch = ddgResults.slice(0, MAX_RESEARCH_PAGES);
    const sources = [];

    for (const result of toFetch) {
      try {
        checkUrl(result.url);
        const extracted = await Promise.race([
          fetchContent(result.url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT_MS)),
        ]);
        const text = (extracted?.text ?? '').trim();
        if (extracted?.fallback || text.length < 80) continue;

        const wrapped = wrapUntrustedContent({ url: result.url, title: extracted.title || result.title, content: text });
        const sourceId = randomUUID();
        db.insertSalesResearchSource({
          id: sourceId, lead_id: leadId, url: result.url,
          title: wrapped.metadata.title, content_excerpt: text.slice(0, 2000),
        });
        sources.push({ id: sourceId, url: result.url, title: wrapped.metadata.title, retrievedAt: wrapped.metadata.retrievedAt, untrusted: true });
      } catch (err) {
        logger?.warn?.({ url: result.url, error_message: err.message }, 'SALES_RESEARCH_PAGE_FAILED');
      }
    }

    return c.json({ ok: true, leadId, sources }, 200);
  });

  // ── ANALYZE + SCORE — deterministic keyword-match scoring against a
  // user-supplied, visible criteria set (sales-scoring.js). Never an
  // LLM-invented number, mirrors investment-scoring.js's discipline. ──
  route.post('/sales/leads/:id/score', async (c) => {
    const leadId = c.req.param('id');
    const lead = db.getSalesLeadById(leadId);
    if (!lead) return c.json({ error: 'lead_not_found' }, 404);

    try { authorizeAction('SCORE'); } catch (err) { return c.json({ error: err.code }, 403); }

    const body = await c.req.json().catch(() => ({}));
    let criteria;
    try { criteria = validateCriteria(body.criteria); } catch (err) { return c.json({ error: err.code }, 400); }

    const sources = db.getSalesResearchSourcesForLead(leadId)
      .map((s) => ({ content: s.content_excerpt }));

    const result = scoreLead({ criteria, sources });
    return c.json({ ok: true, leadId, ...result });
  });

  // ── DRAFT — outreach message or CRM-style note. Text only, local only,
  // always labeled DRAFT — NOT SENT, never dispatched anywhere. ──
  route.post('/sales/leads/:id/draft', async (c) => {
    const leadId = c.req.param('id');
    const lead = db.getSalesLeadById(leadId);
    if (!lead) return c.json({ error: 'lead_not_found' }, 404);

    try { authorizeAction('DRAFT'); } catch (err) { return c.json({ error: err.code }, 403); }

    const body = await c.req.json().catch(() => ({}));
    const kind = body.kind === 'crm_note' ? 'crm_note' : 'outreach_message';
    const sources = db.getSalesResearchSourcesForLead(leadId).map((s) => ({ content: s.content_excerpt }));

    let score = null;
    if (body.criteria !== undefined) {
      let criteria;
      try { criteria = validateCriteria(body.criteria); } catch (err) { return c.json({ error: err.code }, 400); }
      score = scoreLead({ criteria, sources });
    }

    let draft;
    try {
      draft = kind === 'crm_note'
        ? draftCrmNote({ lead, score, sources: db.getSalesResearchSourcesForLead(leadId) })
        : draftOutreachMessage({ lead, score, tone: typeof body.tone === 'string' ? body.tone : 'neutral' });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }

    const draftId = randomUUID();
    db.insertSalesDraft({ id: draftId, lead_id: leadId, kind: draft.kind, subject: draft.subject || '', body: draft.body || draft.note || '' });

    logger?.info?.({ leadId, draftId, kind: draft.kind }, 'SALES_DRAFT_CREATED');
    return c.json({ ok: true, draftId, draft }, 201);
  });

  route.get('/sales/leads/:id/drafts', (c) => {
    const lead = db.getSalesLeadById(c.req.param('id'));
    if (!lead) return c.json({ error: 'lead_not_found' }, 404);
    return c.json({ ok: true, drafts: db.getSalesDraftsForLead(lead.id) });
  });

  return route;
}
