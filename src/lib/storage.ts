import { get, set, del, entries, setMany, createStore } from 'idb-keyval';
import type { Page } from './types';

export type PageMeta = Omit<Page, 'blocks'>;

const store = createStore('docteur-db', 'pages');

// Use the same protocol as the page so there is no mixed-content issue:
//   - localhost (HTTP dev): http://localhost:3001
//   - LAN IP (HTTPS mobile): https://192.168.X.X:3001
const API_BASE = `${window.location.protocol}//${window.location.hostname}:3001`;

export function isRemoteAccess(): boolean {
  const h = window.location.hostname;
  return h !== 'localhost' && h !== '127.0.0.1';
}

// ── Local IndexedDB ───────────────────────────────────────────────────────────

export async function getAllPages(): Promise<Page[]> {
  const all = await entries<string, Page>(store);
  return all
    .map(([, v]) => v)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getPage(id: string): Promise<Page | undefined> {
  return get<Page>(id, store);
}

async function writeLocal(page: Page): Promise<void> {
  await set(page.id, page, store);
}

async function removeLocal(id: string): Promise<void> {
  await del(id, store);
}

// ── Server API ────────────────────────────────────────────────────────────────

async function serverPut(page: Page): Promise<void> {
  const res = await fetch(`${API_BASE}/api/neuron/${page.id}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ page }),
  });
  if (!res.ok) throw new Error(`Serveur ${res.status} — impossible de sauvegarder`);
}

async function serverDelete(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/neuron/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Serveur ${res.status} — impossible de supprimer`);
}

// ── savePage / deletePage ─────────────────────────────────────────────────────
// Remote mode : server is authoritative — await the PUT, throw on failure.
// Local mode  : IndexedDB first, then fire-and-forget server sync.

export async function savePage(page: Page): Promise<void> {
  if (isRemoteAccess()) {
    await serverPut(page);      // throws on failure — caller handles error
    await writeLocal(page);     // local cache after server confirms
  } else {
    await writeLocal(page);
    serverPut(page).catch(() => { /* non-fatal background sync */ });
  }
}

export async function deletePage(id: string): Promise<void> {
  if (isRemoteAccess()) {
    await serverDelete(id);
    await removeLocal(id);
  } else {
    await removeLocal(id);
    serverDelete(id).catch(() => { /* non-fatal */ });
  }
}

// ── Bulk export IndexedDB → server (migration one-shot) ──────────────────────

const SYNC_BATCH = 20;

export async function exportAllToServer(
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  const pages = await getAllPages();
  const total = pages.length;
  let saved = 0;

  for (let i = 0; i < total; i += SYNC_BATCH) {
    const batch = pages.slice(i, i + SYNC_BATCH);
    await fetch(`${API_BASE}/api/neurons/sync`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pages: batch }),
    });
    saved += batch.length;
    onProgress(saved, total);
  }

  return saved;
}

// ── Remote load — fetch all pages from server ─────────────────────────────────

export async function getAllPagesFromServer(): Promise<Page[]> {
  const res = await fetch(`${API_BASE}/api/neurons`);
  if (!res.ok) throw new Error(`GET /api/neurons → ${res.status}`);
  const json = await res.json() as { pages: Page[] };
  return json.pages ?? [];
}

// ── Connectivity check ────────────────────────────────────────────────────────

export async function checkServerOnline(): Promise<boolean> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    const res   = await fetch(`${API_BASE}/api/ping`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Snapshot: bulk-write all server pages to local IDB (offline cache) ────────
// Writes in batches of 100 so a single large transaction failure doesn't lose
// all pages (mobile IDB can reject oversized transactions silently).

const SNAPSHOT_BATCH = 100;

export async function saveSnapshotLocally(pages: Page[]): Promise<void> {
  if (pages.length === 0) return;
  for (let i = 0; i < pages.length; i += SNAPSHOT_BATCH) {
    const batch = pages.slice(i, i + SNAPSHOT_BATCH);
    await setMany(batch.map(p => [p.id, p] as [string, Page]), store);
  }
}

export async function syncPageToServer(id: string): Promise<void> {
  const page = await getPage(id);
  if (!page) return;
  await serverPut(page);
}

// ── Lazy-load server endpoints ────────────────────────────────────────────────
// Returns metadata stubs (no blocks) — used for fast startup and "Tous les neurones".

export async function getRecentPagesFromServer(limit = 50): Promise<Page[]> {
  const res  = await fetch(`${API_BASE}/api/neurons/recent?limit=${limit}`);
  if (!res.ok) throw new Error(`GET /api/neurons/recent → ${res.status}`);
  const json = await res.json() as { pages: PageMeta[] };
  return (json.pages ?? []).map(p => ({ ...p, blocks: [] }));
}

export async function getAllPagesMetaFromServer(): Promise<Page[]> {
  const res  = await fetch(`${API_BASE}/api/neurons/all-meta`);
  if (!res.ok) throw new Error(`GET /api/neurons/all-meta → ${res.status}`);
  const json = await res.json() as { pages: PageMeta[] };
  return (json.pages ?? []).map(p => ({ ...p, blocks: [] }));
}

export async function getPageCountsFromServer(): Promise<{ total: number; byKind: Record<string, number> }> {
  const res = await fetch(`${API_BASE}/api/neurons/counts`);
  if (!res.ok) throw new Error(`GET /api/neurons/counts → ${res.status}`);
  const json = await res.json() as { total: number; byKind: Record<string, number> };
  return { total: json.total ?? 0, byKind: json.byKind ?? {} };
}

export async function getPageFromServer(id: string): Promise<Page | null> {
  const res = await fetch(`${API_BASE}/api/neuron/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/neuron/${id} → ${res.status}`);
  const json = await res.json() as { page: Page };
  return json.page ?? null;
}

export async function hasLocalSnapshot(): Promise<boolean> {
  const all = await entries<string, Page>(store);
  return all.length > 0;
}

// ── Merge server pages into local IndexedDB (PC startup) ─────────────────────
// Bulk approach: one IDB read for all local pages, one bulk write per batch.
// Previous implementation did N sequential getPage() + N writeLocal() calls
// (up to ~1800 IDB transactions for 900 pages = 4-9s of jank on Windows).

export async function mergeServerPagesLocal(): Promise<Page[]> {
  const t0 = performance.now();

  // Parallel: fetch server + read ALL local in one IDB transaction
  const [serverPages, localEntries] = await Promise.all([
    getAllPagesFromServer(),
    entries<string, Page>(store),
  ]);
  const localMap = new Map(localEntries.map(([k, v]) => [k, v]));
  console.log(`[startup] merge — server:${serverPages.length} local:${localEntries.length} fetch+read:${Math.trunc(performance.now() - t0)}ms`);

  const toWrite: [string, Page][] = [];
  const added: Page[] = [];
  for (const page of serverPages) {
    const local = localMap.get(page.id);
    if (!local || page.updatedAt > local.updatedAt) {
      // Merge links: server may have lost some links that local still knows about
      const mergedLinks = [...new Set([...(page.links ?? []), ...(local?.links ?? [])])];
      toWrite.push([page.id, { ...page, links: mergedLinks }]);
      added.push(page);
    }
  }

  if (toWrite.length > 0) {
    const t1 = performance.now();
    for (let i = 0; i < toWrite.length; i += SNAPSHOT_BATCH) {
      await setMany(toWrite.slice(i, i + SNAPSHOT_BATCH), store);
    }
    console.log(`[startup] merge — wrote ${added.length} new/updated to IDB: ${Math.trunc(performance.now() - t1)}ms`);
  }

  return added;
}
