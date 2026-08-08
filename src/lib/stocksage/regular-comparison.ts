import type { RegularContext } from "./evidence/retrieve";
import { humanAsOf } from "./regular-dates";
import type {
  ChatReply,
  ChatRequest,
  FinanceEntity,
} from "./types";
import type { TemporalInterval } from "./temporal";

type RankingWindow = {
  label: string;
  value: (quote: RegularContext["quotes"][number]) => number | null | undefined;
};

function casualName(name: string): string {
  return name.replace(
    /,? (?:inc|corp(?:oration)?|ltd|plc|co)\.?\s*(?:common stock|class [a-c] .*|ordinary shares)?$/i,
    ""
  );
}

function quoteDisplayName(
  entity: FinanceEntity,
  quote: RegularContext["quotes"][number]
): string {
  if (!quote.proxySymbol) {
    return quote.venue === "ASX"
      ? `ASX:${entity.ticker ?? quote.ticker}`
      : entity.ticker ?? casualName(entity.name);
  }
  if (quote.ticker === "AXJO" && quote.proxySymbol === "EWA") {
    return "EWA (Australian-market ETF proxy)";
  }
  return `${quote.proxySymbol} (${quote.proxyKind === "adr" ? `${casualName(entity.name)} ADR proxy` : `${casualName(entity.name)} ETF proxy`})`;
}

function requestedRankingWindow(
  message: string,
  intervals?: readonly TemporalInterval[]
): RankingWindow | null {
  const windows = comparisonWindows(message, intervals);
  return windows.length === 1 ? windows[0] : null;
}

export function buildDeterministicRankingReply(
  request: ChatRequest,
  entities: FinanceEntity[],
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls" | "retryable"> | null {
  if (
    entities.length < 2 ||
    !/\b(?:rank(?:ing|ed)?|order|which\b.{0,50}\b(?:up|gained|performed)\s+more|best performer|performed best)\b/i.test(
      request.message
    )
  ) {
    return null;
  }
  const intervalWindows = context.plan.intervals
    ? quoteWindowsForIntervals(context.plan.intervals)
    : [];
  const windows =
    intervalWindows.length > 0
      ? intervalWindows
      : [
          requestedRankingWindow(request.message, context.plan.intervals),
        ].filter((window): window is RankingWindow => Boolean(window));
  if (windows.length === 0) return null;
  const quoteByTicker = new Map(
    context.quotes.map((quote) => [quote.ticker, quote])
  );
  const lines: string[] = [];
  let anyRanked = false;
  let hasMissing = false;
  for (const window of windows) {
    const rows = entities.map((entity, index) => {
      const quote = entity.ticker ? quoteByTicker.get(entity.ticker) : undefined;
      return {
        entity,
        index,
        value: quote ? window.value(quote) : null,
        quote,
      };
    });
    const ranked = rows
      .filter(
        (row) => typeof row.value === "number" && Number.isFinite(row.value)
      )
      .map((row) => ({ ...row, value: row.value as number }))
      .sort(
        (left, right) =>
          right.value - left.value || left.index - right.index
      );
    if (ranked.length === 0) continue;
    anyRanked = true;
    if (windows.length > 1) lines.push(`**${window.label}**`);
    lines.push(
      ...ranked.map(
        (row, index) =>
          `${index + 1}. **${
            row.quote
              ? quoteDisplayName(row.entity, row.quote)
              : row.entity.ticker ?? casualName(row.entity.name)
          }**, ${row.value >= 0 ? "+" : ""}${row.value.toFixed(2)}%${
            row.quote?.proxySymbol
              ? row.quote.proxyKind === "adr"
                ? ` (${row.quote.proxySymbol} return, not the underlying Australian listing return)`
                : ` (${row.quote.proxySymbol} return, not the underlying index return)`
              : ""
          }`
      )
    );
    const missing = rows.filter((row) => !Number.isFinite(row.value));
    if (missing.length > 0) {
      hasMissing = true;
      lines.push("Ranking uses matched figures only.");
    }
    if (windows.length > 1) lines.push("");
  }
  if (!anyRanked) return null;
  return {
    text: lines.join("\n").trim(),
    citationUrls: [],
    retryable: hasMissing ? true : undefined,
  };
}

export function quoteWindowsForIntervals(
  intervals: readonly TemporalInterval[]
): RankingWindow[] {
  return intervals.flatMap((interval): RankingWindow[] => {
    switch (interval.label) {
      case "today":
        return [{ label: "latest session", value: (quote) => quote.dayPct }];
      case "yesterday":
        return [
          {
            label: "previous session",
            value: (quote) => quote.prevSessionPct,
          },
        ];
      case "last few days":
        return [
          {
            label: "last few sessions",
            value: (quote) => quote.fewDaysPct,
          },
        ];
      case "this week":
        return [
          { label: "week to date", value: (quote) => quote.wtdPct },
        ];
      case "last week":
        return [
          { label: "last week", value: (quote) => quote.lastWeekPct },
        ];
      case "month to date":
        return [
          { label: "month to date", value: (quote) => quote.mtdPct },
        ];
      case "trailing month":
        return [
          { label: "trailing month", value: (quote) => quote.monthPct },
        ];
      case "last month":
        return [
          {
            label: "last calendar month",
            value: (quote) => quote.lastMonthPct,
          },
        ];
      case "this year":
        return [{ label: "YTD", value: (quote) => quote.ytdPct }];
      case "last year":
        return [
          { label: "trailing year", value: (quote) => quote.yearPct },
        ];
      default:
        return [];
    }
  });
}

function comparisonWindows(
  message: string,
  intervals?: readonly TemporalInterval[]
): RankingWindow[] {
  if (intervals && intervals.length > 0) {
    return quoteWindowsForIntervals(intervals);
  }
  const windows: RankingWindow[] = [];
  const add = (pattern: RegExp, window: RankingWindow) => {
    if (pattern.test(message)) windows.push(window);
  };
  add(/\bthis week\b|\blast week\b|\bover the last week\b/i, {
    label: "one week",
    value: (quote) => quote.weekPct,
  });
  add(/\b(?:month[- ]to[- ]date|mtd|this month)\b/i, {
    label: "month to date",
    value: (quote) => quote.mtdPct,
  });
  add(/\b(?:trailing month|last month|over the (?:last|past) month)\b/i, {
    label: "trailing month",
    value: (quote) => quote.monthPct,
  });
  add(/\b(?:ytd|year[- ]to[- ]date|this year)\b/i, {
    label: "YTD",
    value: (quote) => quote.ytdPct,
  });
  return windows.length > 0
    ? windows
    : [{ label: "latest session", value: (quote) => quote.dayPct }];
}

export function comparisonLead(
  message: string,
  entities: FinanceEntity[],
  context: RegularContext
): string[] {
  const asksNonPerformanceCriteria =
    /\b(?:growth|valuation|risk|earnings|dividend|outlook)\b/i.test(message);
  const asksPerformance =
    /\b(?:performance|return|price|today|week|month|year|ytd|mtd)\b/i.test(
      message
    );
  const windows =
    asksNonPerformanceCriteria && !asksPerformance
      ? []
      : comparisonWindows(message, context.plan.intervals);
  const rows = entities.flatMap((entity) => {
    const quote = entity.ticker
      ? context.quotes.find((item) => item.ticker === entity.ticker)
      : undefined;
    const fundamentals = entity.ticker
      ? context.fundamentals.find((item) => item.ticker === entity.ticker)
      : undefined;
    if (!quote && !fundamentals) {
      return entity.private
        ? [
            {
              entity,
              quote: undefined,
              line: `- **${casualName(entity.name)}**, privately held, so there is no public share price or listed-company valuation to compare.`,
            },
          ]
        : [];
    }
    const figures: string[] = [];
    if (quote && windows.length > 0) {
      const periods = windows.map((window) => ({
        label: window.label,
        value: window.value(quote),
      }));
      figures.push(
        `${
          quote.isIndex
            ? quote.price.toFixed(2)
            : `${quote.currency === "AUD" ? "A$" : "$"}${quote.price.toFixed(2)}`
        } at ${humanAsOf(quote.asOf)}${
          quote.eod ? " close" : ""
        }`,
        ...periods
          .filter(
            (period): period is { label: string; value: number } =>
              period.value != null
          )
          .map(
            (period) =>
              `${period.label} ${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`
          )
      );
    }
    if (fundamentals?.peTtm != null) {
      figures.push(`P/E ${fundamentals.peTtm.toFixed(1)}x`);
    }
    if (fundamentals?.revenueGrowthTtmYoy != null) {
      figures.push(
        `revenue growth ${fundamentals.revenueGrowthTtmYoy >= 0 ? "+" : ""}${fundamentals.revenueGrowthTtmYoy.toFixed(1)}%`
      );
    }
    if (fundamentals?.beta != null) {
      figures.push(`beta ${fundamentals.beta.toFixed(2)}`);
    }
    return [
      {
        entity,
        quote,
        line: `- **${
          quote
            ? quoteDisplayName(entity, quote)
            : entity.ticker ?? casualName(entity.name)
        }**, ${figures.join("; ")}.${
          quote?.proxySymbol
            ? quote.proxyKind === "adr"
              ? ` These are ${quote.proxySymbol} figures, not the underlying Australian listing return.`
              : ` These are ${quote.proxySymbol} figures, not the underlying index return.`
            : ""
        }`,
      },
    ];
  });
  if (rows.length === 0) return [];
  const names = entities.map((entity) => casualName(entity.name)).join(" vs ");
  const lines = [`### ${names}`, ...rows.map((row) => row.line)];
  const quoted = rows.filter((row) => row.quote);
  if (quoted.length >= 2) {
    for (const window of windows) {
      const ordered = quoted
        .map((row) => ({ ...row, value: window.value(row.quote!) }))
        .filter(
          (row): row is typeof row & { value: number } =>
            typeof row.value === "number" && Number.isFinite(row.value)
        )
        .sort((left, right) => right.value - left.value);
      if (ordered.length < 2) continue;
      const best = ordered[0];
      const worst = ordered[ordered.length - 1];
      const bestValue = Number(best.value.toFixed(2));
      const worstValue = Number(worst.value.toFixed(2));
      const gap = bestValue - worstValue;
      lines.push(
        ordered.length === 2
          ? `${quoteDisplayName(best.entity, best.quote!)} outperformed ${quoteDisplayName(
              worst.entity,
              worst.quote!
            )} by ${gap.toFixed(2)} percentage points over ${window.label}.`
          : `${quoteDisplayName(best.entity, best.quote!)} ranked first at ${
              bestValue >= 0 ? "+" : ""
            }${bestValue.toFixed(2)}%, while ${quoteDisplayName(
              worst.entity,
              worst.quote!
            )} ranked last at ${
              worstValue >= 0 ? "+" : ""
            }${worstValue.toFixed(2)}% over ${window.label}, a ${gap.toFixed(
              2
            )}-point spread.`
      );
    }
  }
  const fundamentalRows = rows.flatMap((row) => {
    const item = row.entity.ticker
      ? context.fundamentals.find(
          (fundamental) => fundamental.ticker === row.entity.ticker
        )
      : undefined;
    return item ? [{ entity: row.entity, item }] : [];
  });
  const compareMetric = (
    requested: RegExp,
    label: string,
    value: (row: (typeof fundamentalRows)[number]) => number | null,
    preference: "higher" | "lower"
  ) => {
    if (!requested.test(message) || fundamentalRows.length < 2) return;
    const available = fundamentalRows
      .map((row) => ({ ...row, value: value(row) }))
      .filter(
        (row): row is typeof row & { value: number } =>
          typeof row.value === "number" && Number.isFinite(row.value)
      )
      .sort((left, right) =>
        preference === "higher"
          ? right.value - left.value
          : left.value - right.value
      );
    if (available.length < 2) return;
    const difference = Math.abs(available[0].value - available[1].value);
    if (difference < 0.05) {
      lines.push(
        `${label} is effectively similar at the displayed precision for ${casualName(
          available[0].entity.name
        )} and ${casualName(available[1].entity.name)}.`
      );
      return;
    }
    lines.push(
      `${casualName(available[0].entity.name)} has the ${
        preference === "higher" ? "stronger" : "lower"
      } ${label === "P/E" ? "P/E" : label.toLowerCase()} figure on these numbers.`
    );
  };
  const generic = !/\b(?:growth|valuation|risk|earnings|performance|return)\b/i.test(
    message
  );
  compareMetric(
    generic ? /./ : /\bgrowth\b/i,
    "Revenue growth",
    (row) => row.item.revenueGrowthTtmYoy,
    "higher"
  );
  compareMetric(
    generic ? /./ : /\bvaluation\b|\bp\/?e\b/i,
    "P/E",
    (row) => row.item.peTtm,
    "lower"
  );
  compareMetric(
    generic ? /./ : /\brisk\b|\bvolatil/i,
    "Beta",
    (row) => row.item.beta,
    "lower"
  );
  return lines;
}

