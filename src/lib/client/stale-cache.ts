const NAMESPACE = "tradeintel:swr:";
export const DEFAULT_STALE_MAX_AGE_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  ts: number;
}

function isServer(): boolean {
  return typeof window === "undefined";
}

export function readStaleCache<T>(
  key: string,
  maxAgeMs: number = DEFAULT_STALE_MAX_AGE_MS,
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
    // Quota exceeded or private-mode, degrade silently.
  }
}
