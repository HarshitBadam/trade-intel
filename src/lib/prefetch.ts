"use client";

import { useCallback, useRef } from "react";
import { readStaleCache, writeStaleCache } from "./useStaleData";

// ---------------------------------------------------------------------------
// Module-level dedupe state
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();
const recentlyDone = new Map<string, number>();

const DEDUPE_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Core prefetch
// ---------------------------------------------------------------------------

export function prefetch<T>(key: string, fetcher: () => Promise<T>): void {
  if (typeof window === "undefined") return;
  if (!key) return;

  // Skip if a fetch for this key is already running.
  if (inflight.has(key)) return;

  // Skip if we successfully fetched this key recently.
  const doneAt = recentlyDone.get(key);
  if (doneAt !== undefined && Date.now() - doneAt < DEDUPE_WINDOW_MS) return;

  // Skip if the cache already holds a fresh value (default 5 min TTL).
  if (readStaleCache<T>(key) !== undefined) return;

  const promise = fetcher()
    .then((value) => {
      writeStaleCache(key, value);
      recentlyDone.set(key, Date.now());
    })
    .catch(() => {
      // Prefetch is best-effort; swallow errors.
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
}

// ---------------------------------------------------------------------------
// Convenience hook — returns intent handlers to spread onto an element.
// ---------------------------------------------------------------------------

export function usePrefetch<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): {
  onMouseEnter: () => void;
  onFocus: () => void;
  onTouchStart: () => void;
} {
  const keyRef = useRef(key);
  keyRef.current = key;

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const handler = useCallback(() => {
    const k = keyRef.current;
    if (!k) return;
    prefetch(k, fetcherRef.current);
  }, []);

  return { onMouseEnter: handler, onFocus: handler, onTouchStart: handler };
}
