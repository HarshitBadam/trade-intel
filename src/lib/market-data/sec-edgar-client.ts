import "server-only";

import { fetchSecJson } from "./sec-edgar-http";
import {
  normalizeCik,
  normalizeSecSubmission,
  normalizeSecTickerMap,
} from "./sec-edgar-normalization";
import type {
  SecEdgarDependencies,
  SecSubmission,
  SecTickerRecord,
} from "./sec-edgar-types";
import {
  SEC_SUBMISSIONS_URL,
  SEC_TICKERS_URL,
} from "./sec-edgar-urls";

const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const SUBMISSION_CACHE_TTL_MS = 60 * 60 * 1_000;

type CacheEntry<T> = { expiresAt: number; value: Promise<T> };

let tickerMapCache: CacheEntry<SecTickerRecord[]> | undefined;
const submissionCache = new Map<string, CacheEntry<SecSubmission>>();

function usesDefaultDependencies(dependencies: SecEdgarDependencies): boolean {
  return (
    dependencies.fetch === undefined &&
    dependencies.acquire === undefined &&
    dependencies.userAgent === undefined &&
    dependencies.now === undefined
  );
}

async function getTickerMap(
  dependencies: SecEdgarDependencies = {}
): Promise<SecTickerRecord[]> {
  if (!usesDefaultDependencies(dependencies)) {
    return normalizeSecTickerMap(
      await fetchSecJson(SEC_TICKERS_URL, dependencies)
    );
  }
  const now = Date.now();
  if (tickerMapCache && tickerMapCache.expiresAt > now) {
    return tickerMapCache.value;
  }
  const value = fetchSecJson(SEC_TICKERS_URL, dependencies).then(
    normalizeSecTickerMap
  );
  tickerMapCache = { expiresAt: now + TICKER_CACHE_TTL_MS, value };
  try {
    return await value;
  } catch (error) {
    tickerMapCache = undefined;
    throw error;
  }
}

export async function resolveCik(
  ticker: string,
  dependencies: SecEdgarDependencies = {}
): Promise<string | null> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;
  return (await getTickerMap(dependencies)).find(
    (item) => item.ticker === normalized
  )?.cik ?? null;
}

export async function getSecSubmissions(
  cik: string,
  dependencies: SecEdgarDependencies = {}
): Promise<SecSubmission> {
  const normalized = normalizeCik(cik);
  const load = async () =>
    normalizeSecSubmission(
      await fetchSecJson(
        `${SEC_SUBMISSIONS_URL}CIK${normalized}.json`,
        dependencies
      ),
      (dependencies.now ?? (() => new Date()))()
    );
  if (!usesDefaultDependencies(dependencies)) return load();

  const cached = submissionCache.get(normalized);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = load();
  submissionCache.set(normalized, {
    expiresAt: now + SUBMISSION_CACHE_TTL_MS,
    value,
  });
  try {
    return await value;
  } catch (error) {
    submissionCache.delete(normalized);
    throw error;
  }
}

export function resetSecEdgarCache(): void {
  tickerMapCache = undefined;
  submissionCache.clear();
}
