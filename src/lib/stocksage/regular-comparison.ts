import type { RegularContext } from "./evidence/retrieve";
import { humanAsOf } from "./regular-dates";
import type {
  ChatReply,
  ChatRequest,
  FinanceEntity,
} from "./types";

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
  horizon?: string
): RankingWindow | null {
  const text = `${message} ${horizon ?? ""}`;
  if ((horizon?.split(" vs ").length ?? 0) > 1) return null;
  if (/\b(?:ytd|year[- ]to[- ]date|this year)\b/i.test(text)) {
    return { label: "YTD", value: (quote) => quote.ytdPct };
  }
  if (/\b(?:month[- ]to[- ]date|mtd|this month)\b/i.test(text)) {
    return { label: "month to date", value: (quote) => quote.mtdPct };
  }
  if (/\b(?:trailing month|last month|over the (?:last|past) month)\b/i.test(text)) {
    return { label: "trailing month", value: (quote) => quote.monthPct };
  }
  if (/\b(?:this week|last week|over the last week)\b/i.test(text)) {
    return { label: "one week", value: (quote) => quote.weekPct };
  }
  if (/\b(?:last few days|few days)\b/i.test(text)) {
    return { label: "last few sessions", value: (quote) => quote.fewDaysPct };
  }
  if (/\b(?:today|latest session)\b/i.test(text)) {
    return { label: "latest session", value: (quote) => quote.dayPct };
  }
  return null;
}

export function buildDeterministicRankingReply(
  request: ChatRequest,
  entities: FinanceEntity[],
  context: RegularContext,
  horizon?: string
): Pick<ChatReply, "text" | "citationUrls" | "retryable"> | null {
  if (
    entities.length < 2 ||
    !/\b(?:rank(?:ing|ed)?|order|which\b.{0,50}\b(?:up|gained|performed)\s+more|best performer|performed best)\b/i.test(
      request.message
    )
  ) {
    return null;
  }
  const window = requestedRankingWindow(request.message, horizon);
  if (!window) return null;
  const quoteByTicker = new Map(
    context.quotes.map((quote) => [quote.ticker, quote])
  );
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
  if (ranked.length === 0) return null;
  const missing = rows.filter((row) => !Number.isFinite(row.value));
  const lines = ranked.map(
    (row, index) =>
      `${index + 1}. **${
        row.quote
          ? quoteDisplayName(row.entity, row.quote)
          : row.entity.ticker ?? casualName(row.entity.name)
      }**, ${
        row.value >= 0 ? "+" : ""
      }${row.value.toFixed(2)}% ${window.label}${
        row.quote?.proxySymbol
          ? row.quote.proxyKind === "adr"
            ? ` (${row.quote.proxySymbol} return, not the underlying Australian listing return)`
            : ` (${row.quote.proxySymbol} return, not the underlying index return)`
          : ""
      }`
  );
  if (missing.length > 0) lines.push("", "Ranking uses matched figures only.");
  return {
    text: lines.join("\n"),
    citationUrls: [],
    retryable: missing.length > 0 ? true : undefined,
  };
}

function comparisonWindows(message: string): RankingWindow[] {
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
      : comparisonWindows(message);
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
      const gap = ordered[0].value - ordered[1].value;
      lines.push(
        `${quoteDisplayName(ordered[0].entity, ordered[0].quote!)} led ${quoteDisplayName(
          ordered[1].entity,
          ordered[1].quote!
        )} by ${gap.toFixed(2)} percentage points over ${window.label}.`
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

