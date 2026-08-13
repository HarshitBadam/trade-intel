import "server-only";

import { getCuratedPeers, getGroupPeers } from "@/data/fallbacks";
import { hasAlpaca, hasPolygon } from "@/lib/config";
import type {
  Candidate,
  LiveQuote,
  RelatedCard,
  TickerDetail,
} from "../types";
import {
  buildRelationInsight,
  relatedData,
  sanitizeTicker,
  type RelationStats,
} from "../transforms";
import {
  getQuotesForCached,
  getRelatedTickersCached,
  getTickerDetailCached,
  getYearAgoQuotesForCached,
} from "../cache";

const hasPrices = hasAlpaca || hasPolygon;
const MAX_PEERS = 4;
const PEER_POOL_MAX = 18;

export async function getRelatedStocksData(
  ticker: string
): Promise<RelatedCard[]> {
  const symbol = sanitizeTicker(ticker);
  if (!symbol || !hasPrices) return [];

  try {
    const currentDetailPromise = getTickerDetailCached(symbol).catch(
      () => null as TickerDetail | null
    );

    let relatedTickers: string[] = [];
    try {
      relatedTickers = await getRelatedTickersCached(symbol);
    } catch (error) {
      console.error("Related companies lookup failed, using peers:", error);
    }

    const clean = (list: string[]) =>
      list.map(sanitizeTicker).filter((t) => t && t !== symbol);

    const pool = Array.from(
      new Set([
        ...clean(getGroupPeers(symbol)),
        ...clean(relatedTickers),
        ...clean(getCuratedPeers(symbol)),
      ])
    ).slice(0, PEER_POOL_MAX);

    if (pool.length === 0) return [];

    const poolKey = [...new Set([symbol, ...pool])].sort().join(",");
    const marketMap = await getQuotesForCached(poolKey).catch(
      () => ({}) as Record<string, LiveQuote>
    );

    const peerTickers = pool.filter((t) => marketMap[t]).slice(0, MAX_PEERS);
    if (peerTickers.length === 0) return [];

    const finalKey = [...new Set([symbol, ...peerTickers])].sort().join(",");
    const [yearAgoMap, currentDetail, peerDetails] = await Promise.all([
      getYearAgoQuotesForCached(finalKey).catch(
        () => ({}) as Record<string, number>
      ),
      currentDetailPromise,
      Promise.all(
        peerTickers.map((t) =>
          getTickerDetailCached(t).catch(() => null as TickerDetail | null)
        )
      ),
    ]);

    const returnOf = (t: string): number | null => {
      const now = marketMap[t]?.price;
      const ago = yearAgoMap[t];
      return now && ago ? (now / ago - 1) * 100 : null;
    };

    type QuotedCandidate = Candidate & { quote: LiveQuote };
    const candidates: QuotedCandidate[] = peerTickers
      .map((t, i): QuotedCandidate | null => {
        const d = peerDetails[i];
        const q = marketMap[t];
        if (!q) return null;
        return {
          ticker: t,
          name: d?.name ?? t,
          pct: q.percentChange,
          ret1y: returnOf(t),
          volume: q.volume,
          marketCap: d?.marketCap ?? null,
          sicCode: d?.sicCode ?? null,
          sector: d?.sector ?? null,
          quote: q,
        };
      })
      .filter((c): c is QuotedCandidate => c !== null);

    if (candidates.length === 0) return [];

    const curPct = marketMap[symbol]?.percentChange ?? null;
    const curRet = returnOf(symbol);
    const curVol = marketMap[symbol]?.volume ?? null;
    const curCap = currentDetail?.marketCap ?? null;
    const curSic = currentDetail?.sicCode ?? null;
    const curSector = currentDetail?.sector ?? null;

    const subjectStats: RelationStats = {
      ticker: symbol,
      price: marketMap[symbol]?.price ?? null,
      pct: curPct,
      ret1y: curRet,
      volume: curVol,
      marketCap: curCap,
      sector: curSector,
    };
    const peerStats = (c: QuotedCandidate): RelationStats => ({
      ticker: c.ticker,
      price: c.quote.price,
      pct: c.pct,
      ret1y: c.ret1y,
      volume: c.volume,
      marketCap: c.marketCap,
      sector: c.sector,
    });
    const usedKinds = new Set<string>();
    const used = new Set<string>();
    const remaining = () => candidates.filter((c) => !used.has(c.ticker));
    const byCategory: Record<string, RelatedCard> = {};
    const major = (s: string | null) => (s ? s.slice(0, 2) : "");
    const normSector = (s: string | null) => (s ? s.trim().toLowerCase() : "");

    const assignIndustry = (allowFuzzy: boolean) => {
      if (byCategory.industry) return;
      const rem = remaining();
      const pick =
        (curSic && rem.find((c) => c.sicCode === curSic)) ||
        (curSic && rem.find((c) => major(c.sicCode) === major(curSic))) ||
        (curSector &&
          rem.find((c) => normSector(c.sector) === normSector(curSector))) ||
        (allowFuzzy ? rem.find((c) => c.sector) || rem[0] : undefined);
      if (!pick) return;
      used.add(pick.ticker);
      byCategory.industry = {
        title: "Similar Industry",
        data: relatedData(
          pick,
          buildRelationInsight(subjectStats, peerStats(pick), "industry", usedKinds)
        ),
      };
    };

    assignIndustry(false);

    {
      const rem = remaining();
      let pick: QuotedCandidate | undefined;
      const withRet = rem.filter((c) => c.ret1y != null);
      if (curRet != null && withRet.length > 0) {
        pick = withRet.reduce((best, c) =>
          Math.abs(c.ret1y! - curRet) < Math.abs(best.ret1y! - curRet) ? c : best
        );
      } else {
        const withPct = rem.filter((c) => c.pct != null);
        if (curPct != null && withPct.length > 0) {
          pick = withPct.reduce((best, c) =>
            Math.abs(c.pct! - curPct) < Math.abs(best.pct! - curPct) ? c : best
          );
        } else {
          pick = rem[0];
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.return = {
          title: "Similar Return",
          data: relatedData(
            pick,
            buildRelationInsight(subjectStats, peerStats(pick), "return", usedKinds)
          ),
        };
      }
    }

    {
      const rem = remaining();
      const withCap = rem.filter((c) => c.marketCap != null);
      let pick: QuotedCandidate | undefined;
      if (curCap != null && withCap.length > 0) {
        pick = withCap.reduce((best, c) =>
          Math.abs(Math.log(c.marketCap!) - Math.log(curCap)) <
          Math.abs(Math.log(best.marketCap!) - Math.log(curCap))
            ? c
            : best
        );
      } else {
        const withVol = rem.filter((c) => c.volume != null);
        if (curVol != null && withVol.length > 0) {
          pick = withVol.reduce((best, c) =>
            Math.abs(c.volume! - curVol) < Math.abs(best.volume! - curVol) ? c : best
          );
        } else {
          pick = rem[0];
        }
      }
      if (pick) {
        used.add(pick.ticker);
        byCategory.size = {
          title: "Similar Market Cap",
          data: relatedData(
            pick,
            buildRelationInsight(subjectStats, peerStats(pick), "size", usedKinds)
          ),
        };
      }
    }

    assignIndustry(true);

    return [byCategory.return, byCategory.industry, byCategory.size].filter(
      (c): c is RelatedCard => Boolean(c)
    );
  } catch (error) {
    console.error("Related stocks fetch failed:", error);
    return [];
  }
}
