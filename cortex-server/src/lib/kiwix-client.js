import { getKiwixSettings } from './sqlite.js';
import { assertSafeZimSegment, MAX_SEARCH_PAGE_LENGTH } from './kiwix-policy.js';

const TIMEOUT_MS = 10_000;

function baseUrl() {
  const port = getKiwixSettings().port || 8090;
  return `http://127.0.0.1:${port}`;
}

async function kiwixFetch(pathAndQuery, { timeoutMs = TIMEOUT_MS, raw = false } = {}) {
  const url = `${baseUrl()}${pathAndQuery}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`kiwix-serve a répondu ${res.status} pour ${pathAndQuery}`);
    }
    return raw ? res : res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`kiwix-serve ne répond pas (timeout sur ${pathAndQuery}) — vérifie qu'il est démarré.`);
    }
    throw new Error(`Erreur de connexion à kiwix-serve : ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Liste des livres/archives chargées ────────────────────────────────────────

export async function listBooks() {
  const res = await kiwixFetch('/catalog/v2/entries?count=200');
  const xml = await res.text();
  return parseOpdsEntries(xml);
}

// ── Autocomplétion de titres ──────────────────────────────────────────────────

export async function suggest(bookName, query) {
  const q = encodeURIComponent(query);
  const res = await kiwixFetch(`/suggest?content=${encodeURIComponent(bookName)}&term=${q}`);
  const data = await res.json().catch(() => []);
  if (!Array.isArray(data)) return [];
  return data.map(item => ({
    label: stripHighlightTags(item.label ?? item.value ?? ''),
    value: item.value ?? item.path ?? '',
    path: item.path ?? item.value ?? '',
    kind: item.kind ?? 'path',
  })).filter(item => item.path && item.kind !== 'pattern');
}

function stripHighlightTags(s) {
  return String(s).replace(/<\/?b>/g, '');
}

// ── Recherche plein texte (search endpoint, format XML OpenSearch) ───────────

export async function search(bookName, pattern, { pageLength = 20 } = {}) {
  const q = new URLSearchParams({ pattern, pageLength: String(pageLength), format: 'xml' });
  if (bookName) q.set('books.name', bookName);
  const res = await kiwixFetch(`/search?${q.toString()}`);
  const xml = await res.text();
  return parseSearchResults(xml);
}

// [KIWIX-RSS] Real kiwix-serve 3.x answers /search?format=xml with RSS 2.0: <channel> (its own <title>/<link>/
// <description>, ignored) and one <item> per hit: <title>, <link>/content/<book>/<path></link>, <description> (raw <b>
// highlight tags, XML entities), <book><title>archive</title></book>, <wordCount>. The older <result> shape is kept
// unchanged. Zero-dependency, bounded, no DTD / entity expansion beyond the five XML entities and numeric references,
// no network: a malformed or non-local item is skipped on its own, never the whole result set.
const MAX_SEARCH_XML_CHARS = 2_000_000; // pageLength ≤ 50 answers are far smaller; anything beyond is not scanned
const MAX_TITLE_CHARS = 512;
const MAX_SNIPPET_CHARS = 2_000;
const CONTENT_LINK_RE = /^\/content\/([^/?#]+)\/([^?#]+)$/;

export function parseSearchResults(xml) {
  const text = typeof xml === 'string' ? xml.slice(0, MAX_SEARCH_XML_CHARS) : '';
  if (/<result[\s>]/.test(text)) return parseLegacyResults(text).slice(0, MAX_SEARCH_PAGE_LENGTH);
  if (/<rss[\s>]/.test(text) || /<item[\s>]/.test(text)) return parseRssItems(text);
  return [];
}

function parseRssItems(xml) {
  const results = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && results.length < MAX_SEARCH_PAGE_LENGTH) {
    const r = rssItemToResult(m[1]);
    if (r) results.push(r);
  }
  return results;
}

function rssItemToResult(block) {
  try {
    // the nested <book><title> is the archive's title, not the article's
    const own = block.replace(/<book(?:\s[^>]*)?>[\s\S]*?<\/book>/g, '');
    const target = parseLocalContentLink(xmlText(extractTag(own, 'link')));
    if (!target) return null;
    return {
      title: toPlainText(extractTag(own, 'title'), MAX_TITLE_CHARS),
      path: target.path,
      snippet: toPlainText(extractTag(own, 'description'), MAX_SNIPPET_CHARS),
      bookName: target.bookName,
    };
  } catch {
    return null;
  }
}

/**
 * Only a Kiwix-local link /content/<book>/<path> is accepted (absolute, protocol-relative, javascript:, data:, file:,
 * query / fragment, missing book or path ⇒ null). Segments are percent-decoded one by one (a malformed one ⇒ null);
 * the characters that would change meaning when the path is appended raw to /content/<book>/ by getContent() — % ? # /
 * inside a segment — are re-escaped. The same rules as the content route (assertSafeZimSegment) then apply.
 */
function parseLocalContentLink(raw) {
  if (typeof raw !== 'string') return null;
  const link = raw.trim();
  if (!link.startsWith('/content/')) return null;
  const m = CONTENT_LINK_RE.exec(link);
  if (!m) return null;
  const bookName = safeDecode(m[1]);
  if (bookName === null || /[/\\]/.test(bookName)) return null;
  const segments = [];
  for (const seg of m[2].split('/')) {
    if (!seg) return null;
    const d = safeDecode(seg);
    if (d === null || d.includes('\\')) return null;
    segments.push(d.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23').replace(/\//g, '%2F'));
  }
  const path = segments.join('/');
  try { assertSafeZimSegment(bookName); assertSafeZimSegment(path); } catch { return null; }
  return { bookName, path };
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/** Text of an XML node: CDATA kept literal, the five XML entities + numeric references decoded once. */
function xmlText(raw) {
  if (typeof raw !== 'string') return null;
  return decodeXmlEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
}

/** Plain, bounded text: markup removed before and after entity decoding (so escaped HTML is stripped too). */
function toPlainText(raw, max) {
  if (typeof raw !== 'string') return '';
  const noCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const stripped = noCdata.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  return decodeXmlEntities(stripped).replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function decodeXmlEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (match, e) => {
    if (e[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : match;
  });
}

// Pre-RSS shape (<result> blocks) — unchanged behaviour.
function parseLegacyResults(xml) {
  const results = [];
  const entryRe = /<result[^>]*>([\s\S]*?)<\/result>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
    const snippet = extractTag(block, 'snippet');
    const bookNameMatch = extractTag(block, 'bookName');
    if (title || link) {
      results.push({
        title: title ?? '',
        path: link ?? '',
        snippet: (snippet ?? '').replace(/<\/?[^>]+>/g, ''),
        bookName: bookNameMatch ?? '',
      });
    }
  }
  return results;
}

function extractTag(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1].trim() : null;
}
function extractAttr(block, tag, attr) {
  const m = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`).exec(block);
  return m ? m[1] : null;
}

// ── Contenu d'un article (HTML brut, tel que rendu par kiwix-serve) ──────────

export async function getContent(bookName, articlePath) {
  const cleanPath = articlePath.replace(/^\/+/, '');
  const res = await kiwixFetch(`/content/${encodeURIComponent(bookName)}/${cleanPath}`);
  const html = await res.text();
  return { html, contentType: res.headers.get('content-type') ?? 'text/html' };
}

// ── Asset brut (image, css…) — proxié binaire ─────────────────────────────────

export async function getRawAsset(bookName, assetPath) {
  const cleanPath = assetPath.replace(/^\/+/, '');
  const url = `${baseUrl()}/content/${encodeURIComponent(bookName)}/${cleanPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`asset ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Impossible de récupérer l'asset ${assetPath} : ${err.message}`);
  }
}

// ── OPDS parsing (utilisé aussi pour le catalogue local /catalog/v2/entries) ─

export function parseOpdsEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const name = extractTag(block, 'name') ?? extractAttr(block, 'link', 'name');
    const title = extractTag(block, 'title');
    const summary = extractTag(block, 'summary') ?? extractTag(block, 'content');
    const language = extractTag(block, 'language');
    const updated = extractTag(block, 'updated');
    const idTag = extractTag(block, 'id');
    // Acquisition link (the actual .zim/.zim.meta4 download) must win over the
    // human "browse" text/html link — matching text/html first previously sent
    // downloadUrl to the browse.library.kiwix.org page instead of a real download.
    const acquisitionTag = /<link[^>]*rel="http:\/\/opds-spec\.org\/acquisition[^"]*"[^>]*\/?>/.exec(block);
    const acquisitionHref = acquisitionTag ? /href="([^"]*)"/.exec(acquisitionTag[0]) : null;
    const sizeMatch = /length="(\d+)"/.exec(acquisitionTag ? acquisitionTag[0] : block);
    const linkMatch = acquisitionHref
      || /<link[^>]*type="text\/html"[^>]*href="([^"]*)"/.exec(block);
    entries.push({
      id: idTag ?? '',
      name: name ?? '',
      title: title ?? name ?? 'Sans titre',
      description: summary ?? '',
      language: language ?? '',
      updated: updated ?? '',
      sizeBytes: sizeMatch ? Number(sizeMatch[1]) : null,
      downloadUrl: linkMatch ? linkMatch[1] : null,
    });
  }
  return entries;
}
