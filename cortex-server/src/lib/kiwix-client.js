import { getKiwixSettings } from './sqlite.js';

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

function parseSearchResults(xml) {
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
