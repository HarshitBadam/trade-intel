"use client";

import { useCallback, useRef } from "react";
import { readStaleCache, writeStaleCache } from "./useStaleData";

const inflight = new Map<string, Promise<unknown>>();
const recentlyDone = new Map<string, number>();

const DEDUPE_WINDOW_MS = 30_000;

export function prefetch<T>(key: string, fetcher: () => Promise<T>): void {
  if (typeof window === "undefined") return;
  if (!key) return;

  if (inflight.has(key)) return;

  const doneAt = recentlyDone.get(key);
  if (doneAt !== undefined && Date.now() - doneAt < DEDUPE_WINDOW_MS) return;

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
