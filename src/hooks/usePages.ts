import { useState, useEffect, useCallback, useRef } from 'react';
import type { Page, PageKind, Block, BlockType } from '../lib/types';
import {
  getAllPages, getAllPagesFromServer, mergeServerPagesLocal,
  isRemoteAccess, savePage, deletePage as deletePageStorage,
  saveSnapshotLocally,
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
  };
}

// ── Module-level load guards ──────────────────────────────────────────────────
// useRef(false) would reset to false on StrictMode's unmount→remount cycle,
// letting the heavy loads (IDB read, brain build, server merge) run twice in dev.
// Module-level variables survive the cycle and reset only on a full page reload.
let _localLoadStarted  = false;
let _remoteLoadStarted = false;

// ── Module-level load helpers (extracted to avoid deep nesting in useEffect) ──

type SetPages   = (value: Page[] | ((prev: Page[]) => Page[])) => void;
type SetLoading = (value: boolean) => void;

function mergeAdded(added: Page[]): (prev: Page[]) => Page[] {
  return (prev) => {
    const known = new Set(prev.map(p => p.id));
    const fresh = added.filter(p => !known.has(p.id));
    if (fresh.length === 0) return prev;
    return [...fresh, ...prev].sort((a, b) => b.updatedAt - a.updatedAt);
  };
}

// Remote + online: load from server, show UI immediately, write IDB in background.
// Previously awaited saveSnapshotLocally before setLoading(false) — for 900 pages
// this could block the UI for seconds while IDB batches were written.
async function loadRemoteAndCache(setPages: SetPages, setLoading: SetLoading): Promise<void> {
  try {
    const t0 = performance.now();
    const ps = await getAllPagesFromServer();
    console.log(`[startup] remote fetch: ${ps.length} pages in ${Math.trunc(performance.now() - t0)}ms`);
    setPages(ps);
    setLoading(false); // show UI immediately — don't wait for IDB write
    saveSnapshotLocally(ps).catch(() => {}); // write offline cache in background
  } catch {
    // Server unreachable — fall back to local snapshot
    const ps = await getAllPages();
    setPages(ps);
    setLoading(false);
  }
}

// Remote + offline: serve local snapshot saved during last online visit.
async function loadOffline(setPages: SetPages, setLoading: SetLoading): Promise<void> {
  const ps = await getAllPages();
  setPages(ps);
  setLoading(false);
}

async function loadLocal(setPages: SetPages, setLoading: SetLoading): Promise<void> {
  const t0 = performance.now();
  const ps = await getAllPages();
  console.log(`[startup] IDB local read: ${ps.length} pages in ${Math.trunc(performance.now() - t0)}ms`);
  setPages(ps);
  setLoading(false); // UI visible — background merge runs after
  try {
    const added = await mergeServerPagesLocal();
    if (added.length > 0) setPages(mergeAdded(added));
  } catch { /* server offline — that's fine */ }
}

function buildUpserted(prev: Page[], data: { id: string; title: string; kind?: PageKind; content?: string; metadata?: Record<string, unknown> }): Page {
  const existing = prev.find(p => p.id === data.id);
  if (existing) {
    return { ...existing, title: data.title, kind: data.kind ?? existing.kind, metadata: data.metadata ?? existing.metadata, updatedAt: Date.now() };
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
  const [pages, setPages]           = useState<Page[]>([]);
  const [loading, setLoading]       = useState(true);
  const [writeError, setWriteError] = useState<string | null>(null);
  const remote    = useRef(isRemoteAccess()).current;
  const isOnline  = useConnectivity(remote);
  const prevOnlineRef = useRef<boolean | null>(null);

  // ── Local mode: load from IDB + background server merge ─────────────────────

  useEffect(() => {
    if (remote) return;
    if (_localLoadStarted) return;
    _localLoadStarted = true;
    loadLocal(setPages, setLoading);
  }, [remote]);

  // ── Remote mode: load based on connectivity; react to transitions ────────────

  useEffect(() => {
    if (!remote) return;
    const prev = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;

    if (isOnline === null) return; // first check still in progress

    if (prev === null) {
      // Initial load — first time we know connectivity status
      if (_remoteLoadStarted) return; // StrictMode guard
      _remoteLoadStarted = true;
      if (isOnline) {
        loadRemoteAndCache(setPages, setLoading);
      } else {
        loadOffline(setPages, setLoading);
      }
      return;
    }

    if (prev === false && isOnline === true) {
      // Came back online: reload from server and refresh local snapshot
      loadRemoteAndCache(setPages, setLoading);
    }
    // online → offline: keep pages in state, writes blocked via save() below
  }, [remote, isOnline]);

  // ── Helper: save a page and surface server errors ────────────────────────────

  const save = useCallback((page: Page): Promise<void> => {
    if (remote && isOnline === false) {
      const err = new Error('Indisponible hors-ligne — allumez le PC');
      setWriteError(err.message);
      return Promise.reject(err);
    }
    return savePage(page).catch(err => {
      setWriteError((err as Error).message ?? 'Erreur de sauvegarde');
      throw err; // re-throw so callers can abort their state update if needed
    });
  }, [remote, isOnline]);

  // Debounced save helpers to avoid saving on every keystroke
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
    return page;
  }, [save]);

  // ── createPageFromData ───────────────────────────────────────────────────────

  const createPageFromData = useCallback(async (data: Partial<Page> & { title: string; kind?: PageKind }) => {
    const page = makePageFromData(data);
    await save(page);
    setPages(prev => [page, ...prev]);
    return page;
  }, [save]);

  // ── updatePage ───────────────────────────────────────────────────────────────
  // Optimistic update: update React state immediately, then persist.
  // On remote mode, if the server fails the user sees an error toast — the
  // optimistic state stays (page is at least in local IDB on the phone).

  const updatePage = useCallback((id: string, updates: Partial<Omit<Page, 'id' | 'createdAt'>>) => {
    let updated: Page | null = null;
    setPages(prev =>
      prev.map(p => {
        if (p.id !== id) return p;
        updated = { ...p, ...updates, updatedAt: Date.now() };
        return updated;
      })
    );
    // updated is assigned synchronously inside the map above
    if (updated) {
      // Schedule debounced save instead of immediate save to avoid excessive writes
      scheduleSave(updated as Page);
    }
  }, [scheduleSave]);

  // ── removePage ───────────────────────────────────────────────────────────────

  const removePage = useCallback(async (id: string) => {
    await deletePageStorage(id);
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
  }, [save]);

  // ── createLink ───────────────────────────────────────────────────────────────

  const createLink = useCallback((sourceId: string, targetId: string) => {
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
    for (const p of toSave) save(p).catch(() => {});
  }, [save]);

  // ── removeLink ───────────────────────────────────────────────────────────────

  const removeLink = useCallback((sourceId: string, targetId: string) => {
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
    for (const p of toSave) save(p).catch(() => {});
  }, [save]);

  // ── upsertPage ───────────────────────────────────────────────────────────────
  // For existing pages: update title/kind/metadata (preserve blocks & links).
  // For new pages: create with a paragraph block containing `content`.

  const upsertPage = useCallback(async (data: {
    id: string; title: string; kind?: PageKind;
    content?: string; metadata?: Record<string, unknown>;
  }) => {
    // Compute the page to save (read pages snapshot without mutating state yet)
    let toSave: Page | null = null;
    setPages(prev => {
      toSave = buildUpserted(prev, data);
      return prev; // state update happens after save (remote) or optimistically (local)
    });
    if (!toSave) return;
    if (remote) {
      await save(toSave);
      setPages(prev => applyUpserted(prev, toSave as Page));
    } else {
      setPages(prev => applyUpserted(prev, toSave as Page));
      save(toSave).catch(() => {});
    }
  }, [save, remote]);

  const reloadFromServer = useCallback(async () => {
    try {
      const ps = await getAllPagesFromServer();
      setPages(ps);
      saveSnapshotLocally(ps).catch(() => {});
    } catch { /* server offline — keep current state */ }
  }, []);

  return {
    pages, loading, writeError, isOnline,
    createPage, createPageFromData, updatePage, upsertPage, removePage, createLink, removeLink,
    // Flush helpers: force-save pending debounced saves
    flushSave, flushAllSaves,
    reloadFromServer,
  };
}
