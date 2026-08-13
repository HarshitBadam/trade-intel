import "server-only";

import { FINNHUB_API_KEY } from "@/lib/config";
import { slidingLimiter } from "./limiter";

const BASE = "https://finnhub.io/api/v1";
const acquire = slidingLimiter(50, 60_000);

async function finnhubFetch(path: string): Promise<Response> {
  await acquire();
  return fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { "X-Finnhub-Token": FINNHUB_API_KEY ?? "" },
    signal: AbortSignal.timeout(8_000),
  });
}

export type FinnhubSearchHit = {
  description?: string;
  displaySymbol?: string;
  symbol?: string;
  type?: string;
};

export async function finnhubSearch(query: string): Promise<FinnhubSearchHit[]> {
  const res = await finnhubFetch(`/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`finnhub search failed: ${res.status}`);
  const data = (await res.json()) as { result?: FinnhubSearchHit[] };
  return data.result ?? [];
}

export type FinnhubProfile = {
  name?: string;
  ticker?: string;
  marketCapitalization?: number;
  currency?: string;
  finnhubIndustry?: string;
  exchange?: string;
};

export async function finnhubProfile(
  symbol: string
): Promise<FinnhubProfile | null> {
  const res = await finnhubFetch(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`finnhub profile failed: ${res.status}`);
  const data = (await res.json()) as FinnhubProfile;
  if (!data || (!data.name && !data.ticker)) return null;
  return data;
}

export async function finnhubPeers(symbol: string): Promise<string[]> {
  const res = await finnhubFetch(`/stock/peers?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`finnhub peers failed: ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as string[]).filter(Boolean) : [];
}
