import { useState, useEffect, useRef, useCallback } from 'react';
import { cortexClient } from '../lib/cortex/client';
import type { Page } from '../lib/types';

const HEALTH_INTERVAL = 10_000;  // ms
// Debounce for embeddings: make it long to avoid frequent costly index calls
// during typing. 3000ms is a reasonable default; adjust if needed.
const DEBOUNCE_MS     = 3_000;

interface QueueItem {
  type: 'index' | 'delete';
  page?: Page;
  id?: string;
}

export interface CortexState {
  available:         boolean;
  lastCheck:         Date | null;
  indexing:          Set<string>;
  queueSize:         number;
  scheduleIndex:     (page: Page) => void;
  scheduleDelete:    (id: string) => void;
  triggerReindexAll: (pages: Page[], onProgress?: (n: number, total: number) => void) => Promise<number>;
  /** Resolves when all currently-scheduled index calls have completed. Use between batch lots. */
  flushIndex:        () => Promise<void>;
}

export function useCortex(): CortexState {
  const [available, setAvailable]   = useState(false);
  const [lastCheck, setLastCheck]   = useState<Date | null>(null);
  const [indexing, setIndexing]     = useState<Set<string>>(new Set());
  const [queueSize, setQueueSize]   = useState(0);

  const queueRef         = useRef<QueueItem[]>([]);
  const debounceMap      = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const processingQueue  = useRef(false);
  // Semaphore: chains index calls so only one embedding runs at a time.
  const indexChain       = useRef<Promise<void>>(Promise.resolve());

  // ── Mark node as indexing / not indexing ─────────────────────────────────

  function addIndexing(id: string) {
    setIndexing(prev => new Set(prev).add(id));
  }
  function removeIndexing(id: string) {
    setIndexing(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // ── Core index call (single page, non-debounced) ─────────────────────────

  const doIndex = useCallback(async (page: Page): Promise<void> => {
    addIndexing(page.id);
    try {
      await cortexClient.indexNeuron(page);
      if (import.meta.env.DEV) console.log(`[Cortex] ✓ Indexed: "${page.title}"`);
    } catch (e) {
      console.warn(`[Cortex] Index failed for "${page.title}", queuing.`, e);
      // Deduplicate: remove old queue entry for same page, push new
      queueRef.current = queueRef.current.filter(
        item => !(item.type === 'index' && item.page?.id === page.id),
      );
      queueRef.current.push({ type: 'index', page });
      setQueueSize(queueRef.current.length);
    } finally {
      removeIndexing(page.id);
    }
  }, []);

  // ── Process offline queue when server becomes available ───────────────────

  const processQueue = useCallback(async (): Promise<void> => {
    if (processingQueue.current) return;
    if (queueRef.current.length === 0) return;
    processingQueue.current = true;

    if (import.meta.env.DEV) console.log(`[Cortex] Draining queue: ${queueRef.current.length} items`);

    while (queueRef.current.length > 0 && cortexClient.isAvailable) {
      const item = queueRef.current[0];
      try {
        if (item.type === 'index' && item.page) {
          await doIndex(item.page);
        } else if (item.type === 'delete' && item.id) {
          await cortexClient.deleteNeuron(item.id);
          if (import.meta.env.DEV) console.log(`[Cortex] ✓ Deleted: ${item.id}`);
        }
        queueRef.current.shift();
        setQueueSize(queueRef.current.length);
      } catch {
        // Server went down again — stop processing, retry next health check
        console.warn('[Cortex] Queue drain interrupted.');
        break;
      }
    }

    processingQueue.current = false;
  }, [doIndex]);

  // ── Health polling ────────────────────────────────────────────────────────

  const checkHealth = useCallback(async (): Promise<void> => {
    const wasAvailable = cortexClient.isAvailable;
    try {
      await cortexClient.health();
    } catch {
      // health() already updates _available = false
    }
    const nowAvailable = cortexClient.isAvailable;
    setAvailable(nowAvailable);
    setLastCheck(cortexClient.lastCheck);

    // Server just came back — drain the queue
    if (!wasAvailable && nowAvailable && queueRef.current.length > 0) {
      processQueue();
    }
  }, [processQueue]);

  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, HEALTH_INTERVAL);
    return () => clearInterval(id);
  }, [checkHealth]);

  // ── Public: scheduleIndex (debounced per page) ────────────────────────────

  const scheduleIndex = useCallback((page: Page): void => {
    const timers = debounceMap.current;
    if (timers.has(page.id)) clearTimeout(timers.get(page.id)!);
    timers.set(page.id, setTimeout(() => {
      timers.delete(page.id);
      if (cortexClient.isAvailable) {
        // Chain onto the semaphore so embeddings are never concurrent.
        // A 300ms gap between calls lets Ollama release the previous runner.
        indexChain.current = indexChain.current
          .then(() => doIndex(page))
          .then(() => new Promise<void>(r => setTimeout(r, 300)))
          .catch(() => {}); // keep chain alive even if doIndex re-queues
      } else {
        queueRef.current = queueRef.current.filter(
          item => !(item.type === 'index' && item.page?.id === page.id),
        );
        queueRef.current.push({ type: 'index', page });
        setQueueSize(queueRef.current.length);
        if (import.meta.env.DEV) console.log(`[Cortex] Server offline — queued: "${page.title}"`);
      }
    }, DEBOUNCE_MS));
  }, [doIndex]);

  // ── Public: scheduleDelete (immediate, no debounce) ──────────────────────

  const scheduleDelete = useCallback((id: string): void => {
    if (cortexClient.isAvailable) {
      cortexClient.deleteNeuron(id).catch(e =>
        console.warn(`[Cortex] Delete failed for ${id}, queuing.`, e),
      );
    } else {
      queueRef.current.push({ type: 'delete', id });
      setQueueSize(queueRef.current.length);
      if (import.meta.env.DEV) console.log(`[Cortex] Server offline — delete queued: ${id}`);
    }
  }, []);

  // ── Public: triggerReindexAll ─────────────────────────────────────────────

  const triggerReindexAll = useCallback(
    async (pages: Page[], onProgress?: (n: number, total: number) => void): Promise<number> => {
      let indexed = 0;
      for (const page of pages) {
        if (!cortexClient.isAvailable) break;
        await doIndex(page);
        indexed++;
        onProgress?.(indexed, pages.length);
      }
      if (import.meta.env.DEV) console.log(`[Cortex] Re-index complete: ${indexed}/${pages.length}`);
      return indexed;
    },
    [doIndex],
  );

  const flushIndex = useCallback((): Promise<void> => {
    // Returns a promise that resolves when all currently-chained index calls finish.
    // Chain a no-op onto the tail so the caller awaits the last real doIndex call.
    return indexChain.current.then(() => {});
  }, []);

  return { available, lastCheck, indexing, queueSize, scheduleIndex, scheduleDelete, triggerReindexAll, flushIndex };
}
