import {
  getBarsForRange,
  type RangeBarSeries,
} from "@/lib/market-data/range-bars";
import { resolveSecurity } from "@/lib/market-data/security-master";
import {
  isTradingSession,
  latestCompletedSession,
  previousSession,
  type MarketCalendar,
} from "../temporal";
import type { FinanceEntity } from "../types";
import type { MarketPacket, ResolvedPair } from "./contracts";

function calendarFor(entity: FinanceEntity): MarketCalendar {
  return entity.market === "au" || entity.ticker === "AXJO" ? "AU" : "US";
}

function sessionAtOrBefore(
  date: string,
  calendar: MarketCalendar,
  now = new Date()
): string {
  const requested = isTradingSession(date, calendar)
    ? date
    : previousSession(date, calendar);
  const latest = latestCompletedSession(calendar, now);
  return requested > latest ? latest : requested;
}

function venueFor(
  entity: FinanceEntity
): "US" | "ASX" | "INDEX" | "UNKNOWN" {
  if (entity.market === "au") return "ASX";
  if (entity.market === "index") return "INDEX";
  if (entity.market === "us") return "US";
  return "UNKNOWN";
}

function closestBarAtOrBefore(
  series: RangeBarSeries,
  session: string
): RangeBarSeries["bars"][number] | undefined {
  for (let index = series.bars.length - 1; index >= 0; index -= 1) {
    if (series.bars[index].session <= session) return series.bars[index];
  }
  return undefined;
}

export function monthlyClosesFromBars(
  bars: readonly RangeBarSeries["bars"][number][]
): NonNullable<MarketPacket["monthlyCloses"]> {
  const byMonth = new Map<string, RangeBarSeries["bars"][number]>();
  for (const bar of bars) byMonth.set(bar.session.slice(0, 7), bar);
  return [...byMonth.entries()].map(([month, bar]) => ({
    month,
    session: bar.session,
    close: bar.close,
  }));
}

export function quarterlyPerformanceFromBars(
  bars: readonly RangeBarSeries["bars"][number][],
  requestedEnd: string
): NonNullable<MarketPacket["quarterlyPerformance"]> {
  const grouped = new Map<string, RangeBarSeries["bars"][number][]>();
  for (const bar of bars) {
    const month = Number(bar.session.slice(5, 7));
    const quarter = Math.floor((month - 1) / 3) + 1;
    const key = `${bar.session.slice(0, 4)}-Q${quarter}`;
    const current = grouped.get(key);
    if (current) current.push(bar);
    else grouped.set(key, [bar]);
  }
  return [...grouped.entries()].flatMap(([quarter, quarterBars]) => {
    const first = quarterBars[0];
    const last = quarterBars.at(-1);
    if (!first || !last || first.close <= 0) return [];
    const quarterNumber = Number(quarter.at(-1));
    const quarterStartMonth = (quarterNumber - 1) * 3 + 1;
    const quarterEndMonth = quarterNumber * 3;
    const quarterEndDay = new Date(
      Date.UTC(Number(quarter.slice(0, 4)), quarterEndMonth, 0)
    )
      .toISOString()
      .slice(0, 10);
    return [
      {
        quarter,
        startSession: first.session,
        endSession: last.session,
        startClose: first.close,
        endClose: last.close,
        returnPct: ((last.close - first.close) / first.close) * 100,
        status:
          Number(first.session.slice(5, 7)) !== quarterStartMonth ||
          Number(first.session.slice(8, 10)) > 7
            ? "partial"
            : requestedEnd >= quarterEndDay
              ? "complete"
              : "to_date",
      },
    ];
  });
}

async function fetchMarketPacket(
  entity: FinanceEntity,
  dates: readonly string[]
): Promise<MarketPacket | null> {
  if (!entity.ticker || entity.private) return null;
  const calendar = calendarFor(entity);
  const venue = venueFor(entity);
  const sessions = dates
    .map((date) => sessionAtOrBefore(date, calendar))
    .sort();
  const firstRequested = sessions[0];
  const lastRequested = sessions[sessions.length - 1];
  const security =
    venue === "UNKNOWN"
      ? null
      : await resolveSecurity(
          { ticker: entity.ticker, name: entity.name },
          { venue }
        );
  const listingDate = security?.listingDate ?? undefined;
  if (listingDate && lastRequested < listingDate) {
    return {
      entityId: entity.id,
      name: entity.name,
      ticker: entity.ticker,
      calendar,
      status: "unavailable",
      reason: "range_before_listing",
      instrumentSymbol: security?.instrument.symbol ?? entity.ticker,
      currency: security?.instrument.currency,
      requestedPoints: dates.map((requestedDate) => ({ requestedDate })),
      returnKind: dates.length === 1 ? "single_session" : "period",
      listingDate,
      ...(dates.length > 1
        ? { monthlyCloses: [], quarterlyPerformance: [] }
        : {}),
    };
  }
  const startSession = listingDate
    ? [previousSession(firstRequested, calendar), listingDate].sort().at(-1)!
    : previousSession(firstRequested, calendar);
  const series = await getBarsForRange({
    ticker: entity.ticker,
    venue,
    calendar,
    granularity: "1Day",
    startSession,
    endSession: lastRequested,
    adjusted: true,
  });
  const requestedPoints = dates.map((requestedDate) => {
    const bar = closestBarAtOrBefore(
      series,
      sessionAtOrBefore(requestedDate, calendar)
    );
    return {
      requestedDate,
      ...(bar ? { session: bar.session, close: bar.close } : {}),
    };
  });
  const firstPoint =
    typeof requestedPoints[0]?.close === "number"
      ? (requestedPoints[0] as (typeof requestedPoints)[number] & {
          close: number;
        })
      : undefined;
  const finalRequestedPoint = requestedPoints.at(-1);
  const lastPoint =
    typeof finalRequestedPoint?.close === "number"
      ? (finalRequestedPoint as typeof finalRequestedPoint & {
          close: number;
        })
      : undefined;
  const startsBeforeListing = Boolean(
    listingDate && dates[0] < listingDate
  );
  const baseline =
    requestedPoints.length === 1 || startsBeforeListing
      ? series.bars[0]?.close
      : firstPoint?.close;
  const returnPct =
    baseline && lastPoint?.close
      ? ((lastPoint.close - baseline) / baseline) * 100
      : undefined;
  const rangeBars = series.bars.filter(
    (bar) => bar.session >= firstRequested && bar.session <= lastRequested
  );
  const pointToPointReturns = requestedPoints
    .slice(1)
    .flatMap((point, index) => {
      const previous = requestedPoints[index];
      if (
        previous?.close === undefined ||
        previous.close <= 0 ||
        point.close === undefined
      ) {
        return [];
      }
      return [
        {
          fromRequestedDate: previous.requestedDate,
          toRequestedDate: point.requestedDate,
          returnPct: ((point.close - previous.close) / previous.close) * 100,
        },
      ];
    });
  return {
    entityId: entity.id,
    name: entity.name,
    ticker: entity.ticker,
    calendar,
    status: series.status,
    reason: series.reason,
    provider: series.provenance?.provider,
    instrumentSymbol: series.instrumentSymbol,
    currency: security?.instrument.currency,
    requestedPoints,
    firstClose: baseline,
    lastClose: lastPoint?.close,
    returnPct,
    returnKind: dates.length === 1 ? "single_session" : "period",
    listingDate,
    ...(pointToPointReturns.length > 0 ? { pointToPointReturns } : {}),
    ...(dates.length > 1
      ? {
          monthlyCloses: monthlyClosesFromBars(rangeBars),
          quarterlyPerformance: quarterlyPerformanceFromBars(
            rangeBars,
            lastRequested
          ),
        }
      : {}),
  };
}

export async function retrieveMarket(
  pairs: readonly ResolvedPair[]
): Promise<MarketPacket[]> {
  const byEntity = new Map<
    string,
    { entity: FinanceEntity; dates: string[] }
  >();
  for (const pair of pairs) {
    const current = byEntity.get(pair.entity.id);
    if (current) current.dates.push(pair.date);
    else byEntity.set(pair.entity.id, { entity: pair.entity, dates: [pair.date] });
  }
  const results = await Promise.allSettled(
    [...byEntity.values()].map(({ entity, dates }) =>
      fetchMarketPacket(entity, [...new Set(dates)].sort())
    )
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
}
