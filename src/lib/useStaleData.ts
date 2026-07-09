"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StaleState<T> = {
  data: T | undefined;
  isStale: boolean;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
};

export type UseStaleDataOptions = {
  enabled?: boolean;
  maxAgeMs?: number;
};

const NAMESPACE = "tradeintel:swr:";
const DEFAULT_MAX_AGE = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  ts: number;
}

function isServer(): boolean {
  return typeof window === "undefined";
}

export function readStaleCache<T>(
  key: string,
  maxAgeMs: number = DEFAULT_MAX_AGE,
): T | undefined {
  if (isServer()) return undefined;
  try {
    const raw = sessionStorage.getItem(NAMESPACE + key);
    if (!raw) return undefined;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.ts > maxAgeMs) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export function writeStaleCache<T>(key: string, value: T): void {
  if (isServer()) return;
  try {
    const entry: CacheEntry<T> = { value, ts: Date.now() };
    sessionStorage.setItem(NAMESPACE + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded or private-mode — degrade silently.
  }
}

export function useStaleData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: UseStaleDataOptions,
): StaleState<T> {
  const enabled = options?.enabled !== false;
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE;
  const activeKey = key && enabled ? key : null;

  const [data, setData] = useState<T | undefined>(undefined);
  const [isStale, setIsStale] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [refreshTick, setRefreshTick] = useState(0);

  // Stable ref so callers can pass inline arrows without triggering re-fetches.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!activeKey) {
      setData(undefined);
      setIsStale(false);
      setIsLoading(false);
      setError(undefined);
      return;
    }

    // Cancellation flag: late resolutions are ignored once key changes or
    // the component unmounts.
    let cancelled = false;
    const cached = readStaleCache<T>(activeKey, maxAgeMs);

    if (cached !== undefined) {
      setData(cached);
      setIsStale(true);
      setIsLoading(false);
    } else {
      setData(undefined);
      setIsStale(false);
      setIsLoading(true);
    }
    setError(undefined);

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        writeStaleCache(activeKey, result);
        setData(result);
        setIsStale(false);
        setIsLoading(false);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err);
        setIsStale(false);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeKey, maxAgeMs, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return { data, isStale, isLoading, error, refresh };
}
