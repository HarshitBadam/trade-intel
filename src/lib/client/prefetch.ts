import { readStaleCache, writeStaleCache } from "./stale-cache";

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
      // Best-effort; swallow errors.
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
}
