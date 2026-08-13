"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_STALE_MAX_AGE_MS,
  readStaleCache,
  writeStaleCache,
} from "@/lib/client/stale-cache";

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

export function useStaleData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: UseStaleDataOptions,
): StaleState<T> {
  const enabled = options?.enabled !== false;
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
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
