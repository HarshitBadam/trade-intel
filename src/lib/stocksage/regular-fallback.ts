import "server-only";

import {
  expandValidCitations,
  validCitationUrls,
} from "./citations";
import { roundFiguresForDisplay } from "./rounding";
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
        row.quote?.proxySymbol
          ? `${row.quote.proxySymbol} ${row.quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy for ${casualName(row.entity.name)}`
          : row.entity.ticker ?? casualName(row.entity.name)
      }** — ${
        row.value >= 0 ? "+" : ""
      }${row.value.toFixed(2)}% ${window.label}${
        row.quote?.proxySymbol
          ? ` (${row.quote.proxySymbol} return, not the underlying index/listing return)`
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

const JUDGMENT_REQUEST =
  /\b(?:which|who)\b[^.!?]{0,60}\b(?:safest|safer|best|better|riskier|cheapest|strongest|biggest|winner)\b|\b(?:safest|outlook)\b|\bshould i\b|\bwhich (?:one|is|looks)\b/i;

const CRITERION_LABEL: Record<string, string> = {
  performance: "recent performance",
  valuation: "valuation",
  earnings: "earnings",
  growth: "growth",
  risk: "relative risk",
  dividends: "dividends",
  outlook: "the outlook",
  size: "relative size",
  news: "the latest news",
};

function askedDimension(message: string, criteria: string[]): string | null {
  const labels = criteria
    .map((criterion) => CRITERION_LABEL[criterion])
    .filter(Boolean);
  if (labels.length > 0) return labels.join(" and ");
  if (JUDGMENT_REQUEST.test(message)) return "a judgment call like that";
  return null;
}

export function buildFallbackReply(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls" | "retryable"> {
  const lines: string[] = [];
  const historicalRequest =
    /\b(?:yesterday|last (?:few days|week|month|quarter|year)|over the last|between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\b/i.test(
      request.message
    );
  if (context.quotes.length > 0) {
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
      lines.push(
        `- **${quote.proxySymbol ?? quote.ticker}**${
          quote.proxySymbol
            ? ` — ${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy requested for ${quote.ticker}`
            : ""
        } — ${
          quote.isIndex
            ? `${quote.price.toFixed(2)} points`
            : `$${quote.price.toFixed(2)}`
        } as of ${humanAsOf(quote.asOf)}${
          quote.eod ? " close (end-of-day)" : ""
        }${quote.sourceNote ? `; ${quote.sourceNote}` : ""}; ${changes}.`
      );
    }
  }
  if (context.sources.length > 0) {
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
        `Coverage is partial for ${list}; the dated figures and sources above are the reliable portion.`
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
  // Shape the fallback to the question: if the user asked for a judgment or a
  // specific dimension, own the gap up front instead of presenting a data dump
  // as though it were the answer.
  const dimension = askedDimension(request.message, context.plan.criteria);
  if (dimension) {
    lines.unshift(
      `The strongest available read on ${dimension} is in the dated figures and sources below; coverage is partial.`,
      ""
    );
  } else {
    lines.push(
      "",
      "This is the current dated picture; coverage is partial."
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
