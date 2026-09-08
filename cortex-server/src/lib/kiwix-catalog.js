import { parseOpdsEntries } from './kiwix-client.js';

const CATALOG_BASE = 'https://library.kiwix.org/catalog/v2/entries';
const TIMEOUT_MS = 15_000;

// ── Recherche dans le catalogue OPDS distant (library.kiwix.org) ─────────────
// nécessite une connexion internet — c'est la seule partie de la fonctionnalité
// qui n'est pas 100% locale.

export async function searchCatalog({ q, lang, count = 40 } = {}) {
  const params = new URLSearchParams({ count: String(count) });
  if (q) params.set('q', q);
  if (lang) params.set('lang', lang);

  const url = `${CATALOG_BASE}?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`catalogue Kiwix a répondu ${res.status}`);
    const xml = await res.text();
    return parseOpdsEntries(xml);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Le catalogue Kiwix ne répond pas (timeout). Vérifie ta connexion internet.');
    }
    throw new Error(`Impossible de contacter le catalogue Kiwix : ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
