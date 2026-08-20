import { JSDOM } from 'jsdom';

const DDG_HTML   = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 14_000;

/**
 * Search DuckDuckGo and return up to `limit` results.
 * Returns [{ title, url, snippet, domain }].
 * Set offset=30 for a second page (DDG paginates in steps of ~30).
 */
export async function searchDuckDuckGo(query, limit = 10, offset = 0) {
  const params = new URLSearchParams({ q: query, kl: 'fr-fr', ia: 'web' });
  if (offset > 0) params.set('s', String(offset));

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let html;
  try {
    const res = await fetch(`${DDG_HTML}?${params}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Cache-Control':   'no-cache',
      },
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const doc     = new JSDOM(html).window.document;
  const results = [];

  for (const el of doc.querySelectorAll('.result')) {
    if (results.length >= limit) break;

    const a       = el.querySelector('.result__a');
    const snippet = el.querySelector('.result__snippet');
    if (!a) continue;

    // DDG redirects: href="/l/?uddg=<encoded_url>&rut=..."
    const href = a.getAttribute('href') ?? '';
    let realUrl = href;
    try {
      const u    = new URL('https://duckduckgo.com' + href);
      const uddg = u.searchParams.get('uddg');
      if (uddg) realUrl = decodeURIComponent(uddg);
    } catch {
      if (!href.startsWith('http')) continue;
    }

    if (!realUrl.startsWith('http')) continue;

    try {
      const u = new URL(realUrl);
      if (u.hostname.includes('duckduckgo.com')) continue;
    } catch { continue; }

    const title  = (a.textContent ?? '').trim() || 'Sans titre';
    const snip   = (snippet?.textContent ?? '').trim();
    let   domain = realUrl;
    try { domain = new URL(realUrl).hostname.replace(/^www\./, ''); } catch { /* keep full url */ }

    results.push({ title, url: realUrl, snippet: snip, domain });
  }

  return results;
}

/** Remove duplicate URLs and keep insertion order. */
export function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}
