// Article Canonical V1 — single canonicalisation point for article captures.
//
// "info <lien>" (URL extraction) and "info <source> <lien>" + pasted text
// (MSN, paywalls…) used to run two diverging pipelines: different
// normalisation, truncation, prompt, title and parent strategies. Both now
// build the same CanonicalArticle here, analyse it with the same prompt and
// turn it into the same neuron structure. Only the provenance differs.
//
// Everything in this module is pure (no network, no DB, no model): the
// orchestration receives its side effects through `deps`, so the converged
// pipeline is testable without booting server.js.

import { createHash } from 'node:crypto';
import { formatDomainName } from './capture.js';
import { truncateForModel } from './deep-capture.js';

export const CANONICAL_ARTICLE_VERSION = 1;

// ── URL ───────────────────────────────────────────────────────────────────────

// Query parameters that only track the visit and never select content.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'igshid', 'twclid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'xtor', 'at_medium', 'at_campaign', 'ocid', 'cvid',
]);
// MSN adds `ei` to shared article links; elsewhere it may be meaningful.
const MSN_TRACKING_PARAMS = new Set(['ei', 'pc', 'item', 'apiversion', 'noservercache', 'noservertelemetry']);

function isMsnHost(hostname) {
  return /(^|\.)msn\.com$/i.test(hostname);
}

/**
 * Stable identity of an article URL: lowercase host, no fragment, no default
 * port, no tracking parameters, sorted query, no trailing slash. Returns null
 * for anything that is not an http(s) URL.
 */
export function canonicalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const msn = isMsnHost(url.hostname);
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => {
      const k = key.toLowerCase();
      if (k.startsWith('utm_')) return false;
      if (TRACKING_PARAMS.has(k)) return false;
      if (msn && MSN_TRACKING_PARAMS.has(k)) return false;
      return true;
    })
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// ── Text ──────────────────────────────────────────────────────────────────────

// Zero-width characters, BOM and soft hyphen are invisible noise in pasted text.
const INVISIBLE_RE = /[​-‍⁠﻿­]/g;
const HSPACE_RE = /[\t\f\v   -   　]+/g;

/**
 * Same body text whatever the path: NFC, invisible characters removed, one
 * paragraph per non-empty line, paragraphs separated by one blank line.
 */
export function normalizeArticleText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(HSPACE_RE, ' ').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeLine(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Comparison key: case, accents, punctuation and spacing ignored. */
export function textFingerprint(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function contentHashOf(text) {
  const fingerprint = textFingerprint(text);
  return fingerprint ? createHash('sha256').update(fingerprint).digest('hex') : null;
}

function sameText(a, b) {
  const fa = textFingerprint(a);
  return fa !== '' && fa === textFingerprint(b);
}

function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

// ── Title / source ────────────────────────────────────────────────────────────

const TITLE_SEPARATOR_RE = /\s+[-|–—•:]\s+([^-|–—•:]{1,60})$/;

/**
 * Removes a trailing " - MSN" / " | Le Monde" suffix, but only when it names
 * the site itself — a real title containing a dash is never cut.
 */
export function normalizeArticleTitle(title, siteNames = []) {
  let value = normalizeLine(title).slice(0, 600);
  const names = siteNames.map(textFingerprint).filter(Boolean);
  for (let i = 0; i < 2; i += 1) {
    const match = value.match(TITLE_SEPARATOR_RE);
    if (!match || !names.includes(textFingerprint(match[1]))) break;
    value = value.slice(0, match.index).trim();
  }
  return value.slice(0, 300);
}

function siteNamesFor({ siteName, source, url }) {
  const host = hostOf(url);
  const bare = host.replace(/^www\./, '');
  return [siteName, source, host ? formatDomainName(host) : '', bare, bare.split('.')[0]].filter(Boolean);
}

/**
 * Parent / source name, same rule for both paths:
 * the page's own site name, else the source typed by the user, else the
 * domain, else "web". A user source that only restates the domain is shown
 * with the domain's formatting so both paths land on the same parent.
 */
export function resolveSourceName({ siteName, source, url } = {}) {
  const site = normalizeLine(siteName);
  if (site) return { name: site, strategy: 'site_name' };
  const host = hostOf(url);
  const domain = host ? formatDomainName(host) : '';
  const typed = normalizeLine(source);
  if (typed && typed.toLowerCase() !== 'web') {
    const bare = host.replace(/^www\./, '');
    if (domain && [domain, host, bare, bare.split('.')[0]].some(name => sameText(name, typed))) {
      return { name: domain, strategy: 'domain' };
    }
    return { name: typed, strategy: 'user_source' };
  }
  if (domain) return { name: domain, strategy: 'domain' };
  return { name: typed || 'web', strategy: 'default' };
}

// ── Head of the body: headline, byline, date ─────────────────────────────────

const BYLINE_RE = /^(?:par|by|histoire de|story by|écrit par|auteur\s*:)\s+(.{2,80})$/i;
const DATE_LINE_RE = /^(?:(?:publié|mis à jour|modifié|published|updated)(?:[\s:]|$).*|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:\s+(?:à\s+)?\d{1,2}[:h]\d{2})?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}.*)?)$/i;
const HEAD_LINES = 5;

function looksLikeHeadline(line) {
  const words = wordCount(line);
  return words >= 3 && words <= 30 && line.length <= 220 && !/[.;,:]$/.test(line);
}

const MONTHS = new Map(Object.entries({
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}));

function calendarDate(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Publication day as written by the source (YYYY-MM-DD). The day is the
 * business identity of the date: an ISO timestamp from JSON-LD and the
 * "Publié le 03/10/2026 à 10:15" line of a pasted article give the same value.
 * Numeric day/month dates are read in the French order (DD/MM/YYYY); relative
 * dates ("il y a 3 h") have no reference and stay null.
 */
export function toIsoDate(value) {
  const raw = normalizeLine(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!raw) return null;
  let m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return calendarDate(m[1], m[2], m[3]);
  m = raw.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (m) return calendarDate(m[3], m[2], m[1]);
  m = raw.match(/\b(\d{1,2})(?:er)?\s+([a-z]+)\.?,?\s+(\d{4})\b/);
  if (m && MONTHS.has(m[2])) return calendarDate(m[3], MONTHS.get(m[2]), m[1]);
  m = raw.match(/\b([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS.has(m[1])) return calendarDate(m[3], MONTHS.get(m[1]), m[2]);
  return null;
}

function cleanAuthor(value) {
  const author = normalizeLine(Array.isArray(value) ? value.join(', ') : value);
  return author && author.length <= 160 ? author : null;
}

/**
 * Splits the normalised body into its head metadata (headline, byline,
 * date lines, a leading line that only repeats the site name) and the
 * article content. Removal only happens in the first few lines and never
 * leaves the content empty.
 */
function splitHead(content, { title, siteNames, detectTitle }) {
  const paragraphs = content ? content.split('\n\n') : [];
  let index = 0;
  let headline = null;
  let author = null;
  let dateText = null;
  const removed = [];

  while (index < paragraphs.length && index < HEAD_LINES && paragraphs.length - index > 1) {
    const line = paragraphs[index];
    if (siteNames.some(name => sameText(name, line))) { removed.push('site_name'); index += 1; continue; }
    if (title && sameText(title, line)) { headline = headline ?? line; removed.push('title'); index += 1; continue; }
    if (!title && !headline && detectTitle && looksLikeHeadline(line) && removed.every(kind => kind === 'site_name')) {
      headline = line; removed.push('title'); index += 1; continue;
    }
    const byline = line.match(BYLINE_RE);
    if (byline && wordCount(byline[1]) <= 8) { author = author ?? byline[1].trim(); removed.push('byline'); index += 1; continue; }
    if (line.length <= 80 && DATE_LINE_RE.test(line)) { dateText = dateText ?? line; removed.push('date'); index += 1; continue; }
    break;
  }
  return { headline, author, dateText, removed, content: paragraphs.slice(index).join('\n\n') };
}

// ── Canonical article ─────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {'url'|'paste'} input.path   provenance only — never changes the result shape
 * @param {string} input.text          article body (full, untruncated)
 * @param {string} [input.title]       extracted headline (URL path)
 * @param {string} [input.url]
 * @param {string} [input.source]      source typed by the user (paste path)
 * @param {string} [input.siteName]    site name declared by the page
 * @param {string} [input.author]
 * @param {string} [input.publishedAt]
 * @param {string[]} [input.images]
 * @param {object} [input.provenance]  extra provenance (extractor, declared canonical…)
 */
export function buildCanonicalArticle(input = {}) {
  const sourceUrl = canonicalizeUrl(input.url) ? String(input.url).trim() : null;
  const canonicalUrl = canonicalizeUrl(input.url);
  const { name: source, strategy: sourceStrategy } = resolveSourceName({ siteName: input.siteName, source: input.source, url: canonicalUrl });
  const siteNames = siteNamesFor({ siteName: input.siteName, source: input.source, url: canonicalUrl });
  const providedTitle = normalizeArticleTitle(input.title, siteNames);

  const head = splitHead(normalizeArticleText(input.text), {
    title: providedTitle,
    siteNames,
    detectTitle: true,
  });
  const title = providedTitle || normalizeArticleTitle(head.headline, siteNames);
  const content = head.content;
  const author = cleanAuthor(input.author) ?? cleanAuthor(head.author);
  const publishedAt = toIsoDate(input.publishedAt) ?? toIsoDate(head.dateText);
  const images = [...new Set((input.images ?? []).filter(src => typeof src === 'string' && /^https?:\/\//i.test(src)))];

  return {
    version: CANONICAL_ARTICLE_VERSION,
    title,
    content,
    source,
    sourceUrl,
    canonicalUrl,
    author,
    publishedAt,
    media: { images },
    contentHash: contentHashOf(content),
    metadata: {
      provenance: {
        path: input.path === 'paste' ? 'paste' : 'url',
        sourceStrategy,
        titleStrategy: providedTitle ? 'extracted' : (title ? 'first_line' : 'pending'),
        headRemoved: head.removed,
        ...(input.provenance ?? {}),
      },
      word_count: wordCount(content),
    },
  };
}

/**
 * Maps a successful web extraction (deep-capture.js extractContent) onto the
 * canonical pipeline input — the URL-path counterpart of the pasted text.
 */
export function articleInputFromExtraction(url, extraction, { captureId, checkDuplicate = false } = {}) {
  const page = extraction?.page ?? {};
  return {
    path: 'url',
    url,
    text: extraction?.fullText ?? extraction?.text ?? '',
    title: extraction?.title ?? '',
    siteName: page.siteName,
    author: page.author,
    publishedAt: page.publishedAt,
    images: extraction?.imageUrls ?? [],
    extraction: extraction?.extraction ?? null,
    sourceType: extraction?.source_type,
    provenance: {
      extractor: extraction?.extraction?.chosenExtractor ?? null,
      ...(page.declaredCanonical ? { declaredCanonical: page.declaredCanonical } : {}),
    },
    captureId,
    checkDuplicate,
  };
}

// ── Analysis prompt (one prompt for both paths) ──────────────────────────────

export function buildArticleAnalysis(article, { analysisPrompt, styleBlock = '', personaNote = '' } = {}) {
  const { text, truncated } = truncateForModel(article.content);
  const truncatedNote = truncated ? '\n\n⚠️ Contenu tronqué (source trop longue).' : '';
  const system = ['Tu es un assistant d\'analyse de contenu. Produis une synthèse structurée en français avec du Markdown propre.', personaNote]
    .filter(Boolean).join(' ');
  return {
    text,
    truncated,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${analysisPrompt}${styleBlock}\n\nContenu :\n${text}${truncatedNote}` },
    ],
  };
}

// ── Neuron (one structure for both paths) ────────────────────────────────────

export function buildArticleNeurons(article, { analysis, title, modelUsed, captureId, truncated, styleExamplesUsed = [], extraction = null, sourceType } = {}) {
  const linkUrl = article.canonicalUrl;
  const pasted = article.metadata.provenance.path === 'paste';
  return {
    parent: {
      title: article.source,
      kind: 'channel',
      content: article.source,
      metadata: { source: article.source, parentStrategy: article.metadata.provenance.sourceStrategy },
    },
    child: {
      title,
      kind: linkUrl ? 'link' : 'note',
      content: `${String(analysis ?? '').trim()}${linkUrl ? `\n\nSource : ${linkUrl}` : ''}`,
      metadata: {
        ...(article.sourceUrl ? { url: article.sourceUrl } : {}),
        source: article.source,
        deep_capture: true,
        ...(pasted ? { pasted_text: true } : {}),
        word_count: article.metadata.word_count,
        model_used: modelUsed,
        source_type: sourceType ?? (pasted ? 'paste' : 'web'),
        truncated: Boolean(truncated),
        captureId,
        captureStatus: 'EXTRACTED',
        ...(extraction ? { extraction } : {}),
        ...(article.media.images.length > 0 ? { images: article.media.images } : {}),
        ...(styleExamplesUsed.length > 0 ? { style_examples_used: styleExamplesUsed } : {}),
        canonical_article: {
          version: article.version,
          title,
          source: article.source,
          canonicalUrl: article.canonicalUrl,
          contentHash: article.contentHash,
          author: article.author,
          publishedAt: article.publishedAt,
          provenance: article.metadata.provenance,
        },
      },
    },
  };
}

// ── Deduplication (identify, never delete) ───────────────────────────────────

/**
 * Finds an existing article neuron that is the same article: same canonical
 * URL (also against older captures that only stored `metadata.url`) or same
 * content hash. Channels are never matched. Pure: the caller supplies the
 * page summaries and decides what to do — nothing is ever deleted.
 */
export function findDuplicateArticle(pages, { canonicalUrl = null, contentHash = null } = {}) {
  if (!canonicalUrl && !contentHash) return null;
  for (const page of pages ?? []) {
    if (!page || page.kind === 'channel') continue;
    const meta = page.metadata ?? {};
    const canonical = meta.canonical_article ?? {};
    if (canonicalUrl && (canonical.canonicalUrl === canonicalUrl || canonicalizeUrl(meta.url) === canonicalUrl)) {
      return { id: page.id, title: page.title ?? '', matchedBy: 'canonical_url' };
    }
    if (contentHash && canonical.contentHash === contentHash) {
      return { id: page.id, title: page.title ?? '', matchedBy: 'content_hash' };
    }
  }
  return null;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * The single article pipeline shared by URL extraction and pasted text.
 *
 * deps:
 *   analyze({ messages, input, wordCount }) → { ok:true, response, model, … } | { ok:false, error, … }
 *   generateTitle(text) → Promise<string>   (only when no headline is available)
 *   resolveStyle({ type, queryText }) → Promise<{ block, usedExamples }>
 *   personaNote() → string
 *   listPages() → page summaries (only when checkDuplicate)
 *   analysisPrompt: string
 */
export async function runCanonicalArticleCapture(input, deps) {
  const article = buildCanonicalArticle(input);
  const canonical = { canonicalUrl: article.canonicalUrl, contentHash: article.contentHash, title: article.title };

  if (input.checkDuplicate) {
    const existing = findDuplicateArticle(deps.listPages(), article);
    if (existing) return { duplicate: true, fallback: false, existing, canonical, captureId: input.captureId };
  }
  if (!article.content) {
    return { fallback: true, reason: 'empty_content', canonical, captureId: input.captureId };
  }

  const style = await deps.resolveStyle({ type: input.styleExampleType, queryText: article.source });
  const { text, truncated, messages } = buildArticleAnalysis(article, {
    analysisPrompt: deps.analysisPrompt,
    styleBlock: style?.block ?? '',
    personaNote: deps.personaNote(),
  });

  const analysis = await deps.analyze({ messages, input: text, wordCount: article.metadata.word_count });
  if (!analysis.ok) {
    return {
      fallback: true, reason: 'analysis_failed', error: analysis.error, canonical, captureId: input.captureId,
      timings: { aiMs: analysis.aiMs ?? 0, pairAttemptMs: analysis.pairAttemptMs ?? 0 },
    };
  }

  const titleStarted = performance.now();
  let title = article.title;
  if (!title) {
    title = normalizeLine(await Promise.resolve().then(() => deps.generateTitle(text.slice(0, 1000))).catch(() => '')) || article.source;
    article.metadata.provenance.titleStrategy = 'generated';
  }
  const titleMs = Math.round(performance.now() - titleStarted);

  const neurons = buildArticleNeurons(article, {
    analysis: analysis.response,
    title,
    modelUsed: analysis.model,
    captureId: input.captureId,
    truncated,
    styleExamplesUsed: style?.usedExamples ?? [],
    extraction: input.extraction ?? null,
    sourceType: input.sourceType,
  });
  return {
    ...neurons,
    fallback: false,
    model_used: analysis.model,
    captureId: input.captureId,
    canonical: { ...canonical, title },
    timings: { aiMs: analysis.aiMs ?? 0, pairAttemptMs: analysis.pairAttemptMs ?? 0, titleMs },
  };
}
