import { useState, useEffect, useCallback, useRef } from 'react';
import type { Page, PageKind, Block, BlockType } from '../lib/types';
import {
  getAllPages, getAllPagesFromServer, mergeServerPagesLocal,
  isRemoteAccess, savePage, deletePage as deletePageStorage,
  saveSnapshotLocally, getPage,
  getRecentPagesFromServer, getAllPagesMetaFromServer,
  getPageCountsFromServer, getPageFromServer,
} from '../lib/storage';
import { generateId } from '../lib/generateId';
import { useConnectivity } from './useConnectivity';

function makeBlock(type: BlockType = 'paragraph'): Block {
  return { id: generateId(), type, content: '' };
}

function makePage(kind: PageKind = 'note', title = 'Nouveau neurone'): Page {
  return {
    id:        generateId(),
    title,
    kind,
    blocks:    [makeBlock()],
    links:     [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePageFromData(data: Partial<Page> & { title: string; kind?: PageKind }): Page {
  const now = Date.now();
  return {
    id:        data.id ?? generateId(),
    title:     data.title,
    kind:      data.kind ?? 'note',
    blocks:    data.blocks ?? [makeBlock()],
    links:     data.links ?? [],
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
    color:     data.color,
    tags:      data.tags,
    metadata:  data.metadata,
    private:   data.private,
  };
}

// ── Module-level guards (survive StrictMode unmount/remount) ──────────────────
let _localLoadStarted  = false;
let _remoteLoadStarted = false;

// Pages loaded as metadata stubs (blocks: []) — need on-demand fetch when opened
const _lazyIds = new Set<string>();

// ── Type helpers ──────────────────────────────────────────────────────────────

type SetPages   = (value: Page[] | ((prev: Page[]) => Page[])) => void;
type SetLoading = (value: boolean) => void;
type SetCounts  = (value: { total: number; byKind: Record<string, number> }) => void;

function mergeAdded(added: Page[]): (prev: Page[]) => Page[] {
  return (prev) => {
    const known = new Set(prev.map(p => p.id));
    const fresh = added.filter(p => !known.has(p.id));
    if (fresh.length === 0) return prev;
    return [...fresh, ...prev].sort((a, b) => b.updatedAt - a.updatedAt);
  };
}

// ── Lazy startup — server-first, IDB as offline fallback ─────────────────────
// Loads recent N stubs instantly, then syncs IDB in background for offline use.

const INITIAL_LOAD_LIMIT = 50;

async function loadLazy(
  setPages: SetPages,
  setPageCounts: SetCounts,
  setLoading: SetLoading,
): Promise<void> {
  try {
    const [pages, counts] = await Promise.all([
      getRecentPagesFromServer(INITIAL_LOAD_LIMIT),
      getPageCountsFromServer(),
    ]);
    for (const p of pages) _lazyIds.add(p.id);
    setPages(pages);
    setPageCounts(counts);
    setLoading(false);
    // Background: sync ALL pages to IDB so mobile works offline
    mergeServerPagesLocal().catch(() => {});
  } catch {
    // Server unreachable — fall back to full IDB load (offline mode)
    await loadOfflineFallback(setPages, setLoading);
    try {
      const counts = await getPageCountsFromServer();
      setPageCounts(counts);
    } catch { /* server truly offline */ }
  }
}

async function loadOfflineFallback(setPages: SetPages, setLoading: SetLoading): Promise<void> {
  const ps = await getAllPages();
  setPages(ps);
  setLoading(false);
}

// Remote + online: load recent stubs immediately, full snapshot in background.
async function loadRemoteLazy(
  setPages: SetPages,
  setPageCounts: SetCounts,
  setLoading: SetLoading,
): Promise<void> {
  try {
    const [pages, counts] = await Promise.all([
      getRecentPagesFromServer(INITIAL_LOAD_LIMIT),
      getPageCountsFromServer(),
    ]);
    for (const p of pages) _lazyIds.add(p.id);
    setPages(pages);
    setPageCounts(counts);
    setLoading(false);
    // Background: fetch ALL pages and save to IDB for offline use on mobile
    getAllPagesFromServer()
      .then(all => saveSnapshotLocally(all))
      .catch(() => {});
  } catch {
    // Server unreachable: serve local IDB snapshot
    const ps = await getAllPages();
    setPages(ps);
    setLoading(false);
  }
}

// Remote + offline: serve IDB snapshot from last online visit.
async function loadOffline(setPages: SetPages, setLoading: SetLoading): Promise<void> {
  const ps = await getAllPages();
  setPages(ps);
  setLoading(false);
}

function buildUpserted(prev: Page[], data: { id: string; title: string; kind?: PageKind; content?: string; metadata?: Record<string, unknown> }): Page {
  const existing = prev.find(p => p.id === data.id);
  if (existing) {
    return { ...existing, title: data.title, kind: data.kind ?? existing.kind, metadata: data.metadata ?? existing.metadata, blocks: data.content === undefined ? existing.blocks : [{ id: generateId(), type: 'paragraph', content: data.content }], updatedAt: Date.now() };
  }
  const now = Date.now();
  return {
    id:        data.id,
    title:     data.title,
    kind:      data.kind ?? 'note',
    blocks:    [{ id: generateId(), type: 'paragraph', content: data.content ?? '' }],
    links:     [],
    createdAt: now,
    updatedAt: now,
    metadata:  data.metadata,
  };
}

function applyUpserted(prev: Page[], page: Page): Page[] {
  if (prev.some(p => p.id === page.id)) return prev.map(p => p.id === page.id ? page : p);
  return [page, ...prev];
}

export function usePages() {
  const [pages, publishPages] = useState<Page[]>([]);
  // Mutations run synchronously against the latest snapshot, outside React's
  // replayable state updaters. Batched agent actions must see prior writes.
  const livePages = useRef<Page[]>([]);
  const setPages = useCallback((value: Page[] | ((prev: Page[]) => Page[])) => {
    const next = typeof value === 'function' ? value(livePages.current) : value;
    if (localStorage.getItem('docteur-pipeline-debug') === 'true') console.debug('[pipeline] state merge', { before: livePages.current.length, after: next.length });
    livePages.current = next;
    publishPages(next);
  }, []);
  const [loading, setLoading]       = useState(true);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [pageCounts, setPageCounts] = useState<{ total: number; byKind: Record<string, number> }>({ total: 0, byKind: {} });
  const [allMetaLoaded, setAllMetaLoaded] = useState(false);
  const [pageContentLoading, setPageContentLoading] = useState(false);

  const remote     = useRef(isRemoteAccess()).current;
  const isOnline   = useConnectivity(remote);
  const prevOnlineRef = useRef<boolean | null>(null);

  // ── Local mode: lazy-load from server (server is local), IDB for offline ────

  useEffect(() => {
    if (remote) return;
    if (_localLoadStarted) return;
    _localLoadStarted = true;
    loadLazy(setPages, setPageCounts, setLoading);
  }, [remote]);

  // ── Remote mode: lazy-load from server, fall back to IDB offline ─────────────

  useEffect(() => {
    if (!remote) return;
    const prev = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;

    if (isOnline === null) return; // first check still in progress

    if (prev === null) {
      // Initial load
      if (_remoteLoadStarted) return;
      _remoteLoadStarted = true;
      if (isOnline) {
        loadRemoteLazy(setPages, setPageCounts, setLoading);
      } else {
        loadOffline(setPages, setLoading);
      }
      return;
    }

    if (prev === false && isOnline === true) {
      // Came back online
      loadRemoteLazy(setPages, setPageCounts, setLoading);
    }
  }, [remote, isOnline]);

  // ── loadPage — fetch full content (blocks) on demand ─────────────────────────
  // No-ops only if the page is ALREADY present in state and fully loaded.
  // Previously this bailed out whenever `id` wasn't a tracked lazy stub — but
  // only the first 50 recent pages ever get registered as stubs at startup,
  // so clicking a link to any older neuron (never referenced, not even as a
  // stub) matched neither condition and silently did nothing: the neuron was
  // absent from `pages`, so nothing could be found to open, and this bailed
  // before ever fetching it.

  const contentRequests = useRef(new Map<string, Promise<void>>());
  const loadPage = useCallback(async (id: string): Promise<void> => {
    const known = livePages.current.find(p => p.id === id);
    if (known && !_lazyIds.has(id)) return;
    const pending = contentRequests.current.get(id);
    if (pending) return pending;
    const request = (async () => {
      setPageContentLoading(true);
      try {
        let full: Page | null = null;
        // Try server first, IDB as fallback for offline mobile
        if (isOnline !== false) {
          try { full = await getPageFromServer(id); } catch { /* offline cache below */ }
        }
        if (!full) {
          full = await getPage(id) ?? null;
        }
        if (full) {
          _lazyIds.delete(id);
          setPages(prev => {
            if (prev.some(p => p.id === id)) return prev.map(p => p.id === id ? full! : p);
            return [full!, ...prev];
          });
        }
      } catch (e) {
        console.error('[loadPage] error:', e);
      } finally {
        contentRequests.current.delete(id);
        setPageContentLoading(contentRequests.current.size > 0);
      }
    })();
    contentRequests.current.set(id, request);
    return request;
  }, [isOnline, setPages]);

  // ── loadAllMeta — load all pages metadata (no blocks) for "Tous les neurones" ─

  const loadAllMeta = useCallback(async (): Promise<void> => {
    if (allMetaLoaded) return;
    try {
      const all = await getAllPagesMetaFromServer();
      setPages(prev => {
        const fullyLoaded = new Map(prev.filter(p => !_lazyIds.has(p.id)).map(p => [p.id, p]));
        const result = all.map(meta => {
          const existing = fullyLoaded.get(meta.id);
          if (existing) return existing;
          _lazyIds.add(meta.id);
          return meta; // already has blocks: []
        });
        const ids = new Set(result.map(p => p.id));
        return [...prev.filter(p => !ids.has(p.id)), ...result];
      });
      // Update counts from the actual list
      const byKind: Record<string, number> = {};
      for (const p of all) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
      setPageCounts({ total: all.length, byKind });
      setAllMetaLoaded(true);
    } catch { /* server offline — keep current state */ }
  }, [allMetaLoaded]);

  // ── loadAllPagesForReindex — loads full pages with blocks (for reindex) ───────

  const loadAllPagesForReindex = useCallback(async (): Promise<Page[]> => {
    const all = await getAllPagesFromServer(); // full content
    _lazyIds.clear();
    setPages(all);
    const byKind: Record<string, number> = {};
    for (const p of all) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    setPageCounts({ total: all.length, byKind });
    setAllMetaLoaded(true);
    return all;
  }, []);

  // ── Helper: save a page and surface server errors ────────────────────────────

  const save = useCallback((page: Page): Promise<void> => {
    if (_lazyIds.has(page.id)) {
      const error = new Error('Contenu non chargé : sauvegarde refusée');
      setWriteError(error.message);
      return Promise.reject(error);
    }
    if (remote && isOnline === false) {
      const err = new Error('Indisponible hors-ligne — allumez le PC');
      setWriteError(err.message);
      return Promise.reject(err);
    }
    return savePage(page, remote || page.metadata?.source === 'agent').catch(err => {
      setWriteError((err as Error).message ?? 'Erreur de sauvegarde');
      throw err;
    });
  }, [remote, isOnline]);

  const pendingSavesRef = useRef<Map<string, { page: Page; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const SAVE_DEBOUNCE_MS = 800;

  const scheduleSave = useCallback((page: Page) => {
    const map = pendingSavesRef.current;
    const existing = map.get(page.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      map.delete(page.id);
      save(page).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    map.set(page.id, { page, timer });
  }, [save]);

  const flushSave = useCallback((id: string) => {
    const map = pendingSavesRef.current;
    const item = map.get(id);
    if (!item) return Promise.resolve();
    clearTimeout(item.timer);
    map.delete(id);
    return save(item.page).catch(() => {});
  }, [save]);

  const flushAllSaves = useCallback(() => {
    const map = pendingSavesRef.current;
    const promises: Promise<void>[] = [];
    for (const [id, item] of map.entries()) {
      clearTimeout(item.timer);
      promises.push(save(item.page).catch(() => {}));
      map.delete(id);
    }
    return Promise.all(promises).then(() => {});
  }, [save]);

  // ── createPage ───────────────────────────────────────────────────────────────

  const createPage = useCallback(async (kind: PageKind = 'note') => {
    const page = makePage(kind);
    await save(page);
    setPages(prev => [page, ...prev]);
    setPageCounts(c => ({ total: c.total + 1, byKind: { ...c.byKind, [page.kind]: (c.byKind[page.kind] ?? 0) + 1 } }));
    return page;
  }, [save]);

  // ── createPageFromData ───────────────────────────────────────────────────────

  const createPageFromData = useCallback(async (data: Partial<Page> & { title: string; kind?: PageKind }) => {
    const page = makePageFromData(data);
    await save(page);
    setPages(prev => [page, ...prev]);
    setPageCounts(c => ({ total: c.total + 1, byKind: { ...c.byKind, [page.kind]: (c.byKind[page.kind] ?? 0) + 1 } }));
    return page;
  }, [save]);

  // ── updatePage ───────────────────────────────────────────────────────────────

  const updatePage = useCallback(async (id: string, updates: Partial<Omit<Page, 'id' | 'createdAt'>>) => {
    if (_lazyIds.has(id)) await loadPage(id);
    if (_lazyIds.has(id)) throw new Error('Contenu non charge');
    let updated: Page | null = null;
    let oldKind: PageKind | null = null;
    setPages(prev =>
      prev.map(p => {
        if (p.id !== id) return p;
        oldKind = p.kind;
        updated = { ...p, ...updates, updatedAt: Date.now() };
        return updated;
      })
    );
    if (updated) {
      scheduleSave(updated as Page);
      // Update counts if kind changed
      const newKind = (updates as Partial<Page>).kind;
      if (newKind && oldKind && newKind !== oldKind) {
        setPageCounts(c => ({
          total: c.total,
          byKind: {
            ...c.byKind,
            [oldKind!]: Math.max(0, (c.byKind[oldKind!] ?? 0) - 1),
            [newKind]: (c.byKind[newKind] ?? 0) + 1,
          },
        }));
      }
    }
    return updated as Page | null;
  }, [scheduleSave, loadPage]);

  // ── removePage ───────────────────────────────────────────────────────────────

  const removePage = useCallback(async (id: string) => {
    const target = pages.find(p => p.id === id);
    await deletePageStorage(id);
    _lazyIds.delete(id);
    setPages(prev => {
      const result: Page[] = [];
      for (const p of prev) {
        if (p.id === id) continue;
        if (p.links?.includes(id)) {
          const next = { ...p, links: p.links.filter(l => l !== id), updatedAt: Date.now() };
          save(next).catch(() => {});
          result.push(next);
        } else {
          result.push(p);
        }
      }
      return result;
    });
    if (target) {
      setPageCounts(c => ({ total: Math.max(0, c.total - 1), byKind: { ...c.byKind, [target.kind]: Math.max(0, (c.byKind[target.kind] ?? 0) - 1) } }));
    }
  }, [pages, save]);

  // ── createLink ───────────────────────────────────────────────────────────────

  const createLink = useCallback(async (sourceId: string, targetId: string) => {
    await Promise.all([loadPage(sourceId), loadPage(targetId)]);
    const toSave: Page[] = [];
    setPages(prev =>
      prev.map(p => {
        if (p.id === sourceId) {
          if ((p.links ?? []).includes(targetId)) return p;
          const next = { ...p, links: [...(p.links ?? []), targetId], updatedAt: Date.now() };
          toSave.push(next);
          return next;
        }
        if (p.id === targetId) {
          if ((p.links ?? []).includes(sourceId)) return p;
          const next = { ...p, links: [...(p.links ?? []), sourceId], updatedAt: Date.now() };
          toSave.push(next);
          return next;
        }
        return p;
      })
    );
    for (const p of toSave) scheduleSave(p);
    await Promise.all(toSave.map(p => flushSave(p.id)));
  }, [loadPage, scheduleSave, flushSave]);

  // ── removeLink ───────────────────────────────────────────────────────────────

  const removeLink = useCallback(async (sourceId: string, targetId: string) => {
    await Promise.all([loadPage(sourceId), loadPage(targetId)]);
    const toSave: Page[] = [];
    setPages(prev =>
      prev.map(p => {
        if (p.id === sourceId) {
          const next = { ...p, links: (p.links ?? []).filter(l => l !== targetId), updatedAt: Date.now() };
          toSave.push(next);
          return next;
        }
        if (p.id === targetId) {
          const next = { ...p, links: (p.links ?? []).filter(l => l !== sourceId), updatedAt: Date.now() };
          toSave.push(next);
          return next;
        }
        return p;
      })
    );
    for (const p of toSave) scheduleSave(p);
    await Promise.all(toSave.map(p => flushSave(p.id)));
  }, [loadPage, scheduleSave, flushSave]);

  // ── upsertPage ───────────────────────────────────────────────────────────────

  const upsertPage = useCallback(async (data: {
    id: string; title: string; kind?: PageKind;
    content?: string; metadata?: Record<string, unknown>;
  }) => {
    if (_lazyIds.has(data.id)) await loadPage(data.id);
    let toSave: Page | null = null;
    let isNew = false;
    setPages(prev => {
      isNew = !prev.some(p => p.id === data.id);
      toSave = buildUpserted(prev, data);
      return prev;
    });
    if (!toSave) return;
    if (remote) {
      await save(toSave);
      setPages(prev => applyUpserted(prev, toSave as Page));
    } else {
      setPages(prev => applyUpserted(prev, toSave as Page));
      save(toSave).catch(() => {});
    }
    if (isNew) {
      const kind = (toSave as Page).kind;
      setPageCounts(c => ({ total: c.total + 1, byKind: { ...c.byKind, [kind]: (c.byKind[kind] ?? 0) + 1 } }));
    }
  }, [save, remote, loadPage]);

  const reloadFromServer = useCallback(async () => {
    try {
      const ps = await getAllPagesFromServer();
      setPages(ps);
      _lazyIds.clear();
      setAllMetaLoaded(true);
      const byKind: Record<string, number> = {};
      for (const p of ps) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
      setPageCounts({ total: ps.length, byKind });
      saveSnapshotLocally(ps).catch(() => {});
    } catch { /* server offline — keep current state */ }
  }, []);

  return {
    pages, loading, writeError, isOnline,
    pageCounts, allMetaLoaded, pageContentLoading,
    createPage, createPageFromData, updatePage, upsertPage, removePage, createLink, removeLink,
    flushSave, flushAllSaves,
    reloadFromServer,
    loadPage, loadAllMeta, loadAllPagesForReindex,
  };
}
