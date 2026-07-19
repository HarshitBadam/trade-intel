import "server-only";

import {
  expandValidCitations,
  validCitationUrls,
} from "./citations";
import { roundFiguresForDisplay } from "./rounding";
import { hasSmuggledOffTopicTask } from "./regular-guards";
import type { RegularContext } from "./retrieve";
import type {
  ChatReply,
  ChatRequest,
  EvidenceSource,
  FinanceEntity,
  RouteDecision,
} from "./types";

type RankingWindow = {
  label: string;
  value: (quote: RegularContext["quotes"][number]) => number | null | undefined;
};

function quoteDisplayName(
  entity: FinanceEntity,
  quote: RegularContext["quotes"][number]
): string {
  if (!quote.proxySymbol) return entity.ticker ?? casualName(entity.name);
  if (quote.ticker === "AXJO" && quote.proxySymbol === "EWA") {
    return "EWA (Australian-market ETF proxy)";
  }
  return `${quote.proxySymbol} (${quote.proxyKind === "adr" ? `${casualName(entity.name)} ADR proxy` : `${casualName(entity.name)} ETF proxy`})`;
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
      }** — ${
        row.value >= 0 ? "+" : ""
      }${row.value.toFixed(2)}% ${window.label}${
        row.quote?.proxySymbol
          ? row.quote.proxyKind === "adr"
            ? ` (${row.quote.proxySymbol} return, not the underlying Australian listing return)`
            : ` (${row.quote.proxySymbol} return, not the underlying index return)`
          : ""
      }`
  );
  for (const row of missing) {
    lines.push(
      `- **${row.entity.ticker ?? casualName(row.entity.name)}** — unranked; ${window.label} figure unavailable.`
    );
  }
  return {
    text: lines.join("\n"),
    citationUrls: [],
    retryable: missing.length > 0 ? true : undefined,
  };
}

function safeEvidenceNote(source: EvidenceSource): string | null {
  const clean = source.excerpt
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_`>\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = clean
    .split(/(?<=[.!?])\s+/)
    .find(
      (candidate) =>
        candidate.length >= 35 &&
        !/\b(?:ignore (?:all |the )?(?:previous|prior)|system prompt|developer message|follow these instructions|you are chatgpt)\b/i.test(
          candidate
        )
    );
  if (!sentence) return null;
  return `${sentence.slice(0, 260).replace(/[,:;–—-]\s*$/, "")}${
    sentence.length > 260 ? "…" : ""
  }`;
}

function casualName(name: string): string {
  return name.replace(
    /,? (?:inc|corp(?:oration)?|ltd|plc|co)\.?\s*(?:common stock|class [a-c] .*|ordinary shares)?$/i,
    ""
  );
}

// Quote timestamps can arrive as full ISO instants; users should see
// market-session wording, never "2026-07-13T04:00:00.000Z" (FQ-13).
export function humanAsOf(asOf: string): string {
  if (!asOf.includes("T")) return asOf;
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) return asOf.split("T")[0];
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(parsed);
}

// Source publish dates can span well over a year back (freshnessDays goes up
// to 3650), so unlike a quote's as-of date, the year matters for clarity.
export function humanPublishedAt(value: string): string {
  if (!value.includes("T")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.split("T")[0];
  const sameYear = parsed.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "America/New_York",
  }).format(parsed);
}

function comparisonLead(
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
    if (!quote && !fundamentals) return [];
    const figures: string[] = [];
    if (quote && windows.length > 0) {
      const periods = windows.map((window) => ({
        label: window.label,
        value: window.value(quote),
      }));
      figures.push(
        `${quote.isIndex ? quote.price.toFixed(2) : `$${quote.price.toFixed(2)}`} at ${humanAsOf(quote.asOf)}${
          quote.eod ? " close" : ""
        }`,
        ...periods.map(
          (period) =>
            `${period.label} ${
              period.value == null
                ? "not available"
                : `${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`
            }`
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
        }** — ${figures.join("; ")}.${
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

export function buildFallbackReply(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls" | "retryable"> {
  const lines: string[] =
    decision.route === "comparison"
      ? comparisonLead(request.message, entities, context)
      : [];
  const historicalRequest =
    /\b(?:yesterday|last (?:few days|week|month|quarter|year)|over the last|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\b/i.test(
      request.message
    );
  if (context.quotes.length > 0 && decision.route !== "comparison") {
    lines.push("### Market snapshot");
    for (const quote of context.quotes) {
      const periods: { label: string; value: number | null | undefined }[] = [];
      const addPeriod = (
        pattern: RegExp,
        label: string,
        value: number | null | undefined
      ): void => {
        if (pattern.test(request.message)) periods.push({ label, value });
      };
      addPeriod(/\bthis week\b|\blast week\b|\bover the last week\b/i, "one week", quote.weekPct);
      addPeriod(/\b(?:month[- ]to[- ]date|mtd|this month)\b/i, "month to date", quote.mtdPct);
      addPeriod(/\b(?:trailing month|last month|over the (?:last|past) month)\b/i, "trailing month", quote.monthPct);
      addPeriod(/\b(?:ytd|year[- ]to[- ]date|this year)\b/i, "YTD", quote.ytdPct);
      addPeriod(/\blast (?:year|12 months)|\bover the last year\b/i, "trailing year", quote.yearPct);
      addPeriod(
        /\blast few days\b|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|\bthe other day\b/i,
        "last few sessions",
        quote.fewDaysPct
      );
      if (periods.length === 0) {
        periods.push({ label: "latest session", value: quote.dayPct });
      }
      const changes = periods
        .map((period) => {
          const change =
            period.value == null
              ? "not available"
              : `${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`;
          return `${period.label} ${change}`;
        })
        .join("; ");
      if (quote.proxySymbol) {
        const entity = entities.find((item) => item.ticker === quote.ticker);
        if (
          quote.ticker === "AXJO" &&
          quote.proxySymbol === "EWA" &&
          periods.length === 1 &&
          periods[0].label === "latest session" &&
          periods[0].value != null
        ) {
          const verb = periods[0].value >= 0 ? "rose" : "fell";
          lines.push(
            `EWA, an Australian-market ETF proxy, ${verb} ${Math.abs(
              periods[0].value
            ).toFixed(
              2
            )}% in its latest session. It tracks broad Australian equities; this is not an ASX index return.`
          );
          continue;
        }
        const displayName = entity
          ? quoteDisplayName(entity, quote)
          : `${quote.proxySymbol} (${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy)`;
        const distinction =
          quote.ticker === "AXJO" && quote.proxySymbol === "EWA"
            ? "It tracks broad Australian equities; this is not an ASX index return."
            : `This is ${quote.proxySymbol} performance; it is not ${
                entity ? casualName(entity.name) : quote.ticker
              } itself.`;
        lines.push(
          `- **${displayName}** — $${quote.price.toFixed(
            2
          )} at ${humanAsOf(quote.asOf)}${
            quote.eod ? " close" : ""
          }, ${changes.replace(/^latest session /, "")}. ${distinction}`
        );
      } else {
        lines.push(
          `- **${quote.ticker}** — ${
            quote.isIndex
              ? `${quote.price.toFixed(2)} points`
              : `$${quote.price.toFixed(2)}`
          } as of ${humanAsOf(quote.asOf)}${
            quote.eod ? " close (end-of-day)" : ""
          }${quote.sourceNote ? `; ${quote.sourceNote}` : ""}; ${changes}.`
        );
      }
    }
  }
  const comparisonNeedsArticles =
    decision.route !== "comparison" ||
    /\b(?:news|development|event|security|cyber|legal|regulat|lawsuit|catalyst|outlook)\b/i.test(
      request.message
    );
  if (context.sources.length > 0 && comparisonNeedsArticles) {
    if (lines.length > 0) lines.push("");
    const displayedSources =
      decision.route === "comparison"
        ? entities
            .map((entity) =>
              context.sources.find((source) =>
                source.entityIds.includes(entity.id)
              )
            )
            .filter(
              (source, index, list) =>
                Boolean(source) && list.indexOf(source) === index
            )
            .slice(0, 8)
        : context.sources.slice(0, 3);
    lines.push(
      decision.route === "comparison"
        ? "### Evidence checked"
        : historicalRequest
          ? "### Evidence for the requested period"
          : "### Best current sources"
    );
    for (const source of displayedSources) {
      if (!source) continue;
      const names = source.entityIds
        .map((id) => {
          const name = entities.find((entity) => entity.id === id)?.name;
          return name ? casualName(name) : undefined;
        })
        .filter(Boolean)
        .join(", ");
      const note = safeEvidenceNote(source);
      lines.push(
        `- **${names || "Requested topic"}** — ${
          note ? `${note} — ` : ""
        }${source.outlet}${
          source.publishedAt ? ` (${humanPublishedAt(source.publishedAt)})` : ""
        } [${source.id}]`
      );
    }
  }
  if (decision.route === "comparison") {
    const missing = entities.filter(
      (entity) => context.coverage[entity.id] !== "covered"
    );
    const names = missing.map((entity) => casualName(entity.name));
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    if (missing.length > 0 && lines.length === 0) {
      const allPrivate =
        entities.length > 0 && entities.every((entity) => entity.private);
      return {
        text: allPrivate
          ? `${list} are privately held, so there are no public share prices to compare. Current company reporting is temporarily unavailable; try again shortly for a news- and business-based comparison.`
          : `Current, like-for-like figures for ${list} aren’t available at this moment. Try again shortly and I’ll run the comparison from fresh data.`,
        citationUrls: [],
        retryable: true,
      };
    }
    if (missing.length > 0) {
      lines.push(
        "",
        `Coverage is partial for ${list}; ${
          comparisonNeedsArticles && context.sources.length > 0
            ? "the dated figures and cited reporting above are the reliable portion"
            : "the dated figures above are the reliable portion"
        }.`
      );
    }
  }
  if (
    decision.route === "stable_finance" &&
    /\b(?:p\/?e|price[- ]to[- ]earnings)\b/i.test(request.message)
  ) {
    return {
      text: "A P/E ratio is a company’s share price divided by its earnings per share. It shows how much investors are paying for each dollar of earnings; compare it with similar companies and consider growth, earnings quality, and debt.",
      citationUrls: [],
    };
  }
  if (
    lines.length === 0 &&
    decision.route === "current_finance" &&
    /\bfortune\s*(?:100|500)\b/i.test(request.message)
  ) {
    return {
      text: "The current Fortune revenue ranking isn’t available from a recent source right now. Try again shortly for the names and revenue figures.",
      citationUrls: [],
      retryable: true,
    };
  }
  if (
    decision.route === "stable_finance" &&
    /\b(?:dividend yield)\b/i.test(request.message)
  ) {
    return {
      text: "Dividend yield is the annual dividend per share divided by the current share price. It helps compare income return, but a very high yield can also signal that the market expects the dividend to be cut.",
      citationUrls: [],
    };
  }
  if (
    decision.route === "stable_finance" &&
    /\b(?:market cap|market capitalisation|market capitalization)\b/i.test(
      request.message
    )
  ) {
    return {
      text: "Market capitalization is share price multiplied by shares outstanding. It measures the market value of a company’s equity—not its revenue, cash balance, or total enterprise value.",
      citationUrls: [],
    };
  }
  if (
    decision.route === "stable_finance" &&
    /\bfortune\s*(?:100|500)\b/i.test(request.message)
  ) {
    return {
      text: "The Fortune 500 and Fortune 100 are annual rankings of large US companies by revenue. They are lists, not companies, funds, indices, or directly tradable securities.",
      citationUrls: [],
    };
  }
  if (
    decision.route === "stable_finance" &&
    /\b(?:fraud|market manipulation)\b/i.test(request.message)
  ) {
    return {
      text: "For investors, the main warning signs are repeated accounting restatements, weak board oversight, unusual related-party transactions, unexplained executive trading, aggressive non-GAAP adjustments, auditor turnover, and regulatory investigations. None proves misconduct alone; the concern rises when several appear together and management’s explanations do not reconcile with filings or cash flow.",
      citationUrls: [],
    };
  }
  if (lines.length === 0) {
    const allPrivate =
      entities.length > 0 && entities.every((entity) => entity.private);
    const privateNames = entities.map((entity) => casualName(entity.name));
    const privateList =
      privateNames.length > 1
        ? `${privateNames.slice(0, -1).join(", ")} and ${privateNames.at(-1)}`
        : privateNames[0];
    return {
      text:
        allPrivate
          ? `${privateList} ${
              entities.length === 1 ? "is" : "are"
            } privately held, so ${
              entities.length === 1 ? "its shares aren’t" : "their shares aren’t"
            } publicly traded. Current reporting is temporarily unavailable; try again shortly for the business, news, and risk picture.`
          : decision.route === "current_finance" ||
              decision.route === "comparison"
            ? "Fresh market data isn’t available at this moment. Try again shortly — your conversation and question are still here."
            : "That answer didn’t come together cleanly. Try again in a moment.",
      citationUrls: [],
      retryable: true,
    };
  }
  if (decision.route !== "comparison") {
    lines.push(
      "",
      context.sources.length === 0 &&
        /\b(?:news|development|catalyst|outlook|guidance|risks?|bull case|bear case)\b/i.test(
          request.message
        )
        ? "No specific news catalyst is attached to these market figures in the available reporting."
        : "This is the current dated picture; coverage is partial."
    );
  }
  if (hasSmuggledOffTopicTask(request.message)) {
    lines.unshift(
      "The calculation is outside my finance lane, so I haven’t evaluated it. Here’s the market part:",
      ""
    );
  }
  const text = lines.join("\n");
  return {
    text: roundFiguresForDisplay(
      expandValidCitations(text, context.sources)
    ),
    citationUrls: validCitationUrls(text, context.sources),
    retryable: true,
  };
}
