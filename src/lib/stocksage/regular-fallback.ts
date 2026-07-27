import "server-only";

import {
  expandValidCitations,
  validCitationUrls,
} from "./citations";
import { roundFiguresForDisplay } from "./rounding";
import { comparisonLead, buildDeterministicRankingReply } from "./regular-comparison";
import { humanAsOf, humanPublishedAt } from "./regular-dates";
import { hasSmuggledOffTopicTask } from "./regular-guards";
import type { RegularContext } from "./retrieve";
import type {
  ChatReply,
  ChatRequest,
  EvidenceSource,
  FinanceEntity,
  RouteDecision,
} from "./types";

function casualName(name: string): string {
  return name.replace(
    /,? (?:inc|corp(?:oration)?|ltd|plc|co)\.?\s*(?:common stock|class [a-c] .*|ordinary shares)?$/i,
    ""
  );
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
  return `${sentence.slice(0, 260).replace(/[,:;,, -]\s*$/, "")}${
    sentence.length > 260 ? "." : ""
  }`;
}

export function buildFallbackReply(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls" | "retryable"> {
  if (
    decision.route === "comparison" &&
    entities.length > 0 &&
    entities.every((entity) => entity.private) &&
    context.quotes.length === 0 &&
    context.fundamentals.length === 0 &&
    context.sources.length === 0
  ) {
    const names = entities.map((entity) => casualName(entity.name));
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    return {
      text: `${list} are privately held, so the useful comparison is operating performance, funding, growth, and risk rather than public-share returns. Name the dimension you want ranked.`,
      citationUrls: [],
      retryable: true,
    };
  }

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
      if (periods.length === 0) periods.push({ label: "latest session", value: quote.dayPct });
      const changes = periods
        .filter(
          (period): period is { label: string; value: number } =>
            period.value != null
        )
        .map(
          (period) =>
            `${period.label} ${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`
        )
        .join("; ");
      const changesSuffix = changes ? `, ${changes}` : "";
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
          ? `${quote.proxySymbol} (${quote.proxyKind === "adr" ? `${casualName(entity.name)} ADR proxy` : `${casualName(entity.name)} ETF proxy`})`
          : `${quote.proxySymbol} (${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy)`;
        const distinction =
          quote.ticker === "AXJO" && quote.proxySymbol === "EWA"
            ? "It tracks broad Australian equities; this is not an ASX index return."
            : quote.proxyKind === "adr"
              ? `These are ${quote.proxySymbol} ADR returns, not ${
                  entity?.ticker
                    ? `ASX:${entity.ticker}`
                    : "the underlying Australian listing"
                } returns.`
            : `This is ${quote.proxySymbol} performance; it is not ${
                entity ? casualName(entity.name) : quote.ticker
              } itself.`;
        lines.push(
          `- **${displayName}**, $${quote.price.toFixed(
            2
          )} at ${humanAsOf(quote.asOf)}${
            quote.eod ? " close" : ""
          }${changesSuffix.replace(", latest session ", ", ")}. ${distinction}`
        );
      } else {
        lines.push(
          `- **${quote.ticker}**, ${
            quote.isIndex
              ? `${quote.price.toFixed(2)} points`
              : `$${quote.price.toFixed(2)}`
          } as of ${humanAsOf(quote.asOf)}${
            quote.eod ? " close (end-of-day)" : ""
          }${quote.sourceNote ? `; ${quote.sourceNote}` : ""}${changesSuffix}.`
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
              context.sources.find((source) => source.entityIds.includes(entity.id))
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
        `- **${names || "Requested topic"}**, ${
          note ? `${note}, ` : ""
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
          ? `${list} are privately held, so the useful comparison is operating performance, funding, growth, and risk rather than public-share returns. Name the dimension you want ranked.`
          : `Choose one common metric and period for ${list}—price performance, valuation, growth, or risk—and I’ll keep the ranking strictly like-for-like.`,
        citationUrls: [],
        retryable: true,
      };
    }
    if (missing.length > 0) {
      lines.push(
        "",
        `${list} remain outside the matched ranking; ${
          comparisonNeedsArticles && context.sources.length > 0
            ? "the ranking above is limited to the dated figures and cited reporting"
            : "the ranking above is limited to the dated figures"
        }.`
      );
    }
  }

  const stableAnswers: [RegExp, string][] = [
    [
      /\b(?:p\/?e|price[- ]to[- ]earnings)\b/i,
      "A P/E ratio is a company’s share price divided by its earnings per share. It shows how much investors are paying for each dollar of earnings; compare it with similar companies and consider growth, earnings quality, and debt.",
    ],
    [
      /\b(?:dividend yield)\b/i,
      "Dividend yield is the annual dividend per share divided by the current share price. It helps compare income return, but a very high yield can also signal that the market expects the dividend to be cut.",
    ],
    [
      /\b(?:market cap|market capitalisation|market capitalization)\b/i,
      "Market capitalization is share price multiplied by shares outstanding. It measures the market value of a company’s equity, not its revenue, cash balance, or total enterprise value.",
    ],
    [
      /\bfortune\s*(?:100|500)\b/i,
      "The Fortune 500 and Fortune 100 are annual rankings of large US companies by revenue. They are lists, not companies, funds, indices, or directly tradable securities.",
    ],
    [
      /\b(?:fraud|market manipulation)\b/i,
      "For investors, the main warning signs are repeated accounting restatements, weak board oversight, unusual related-party transactions, unexplained executive trading, aggressive non-GAAP adjustments, auditor turnover, and regulatory investigations. None proves misconduct alone; the concern rises when several appear together and management’s explanations do not reconcile with filings or cash flow.",
    ],
  ];
  if (decision.route === "stable_finance") {
    const answer = stableAnswers.find(([pattern]) => pattern.test(request.message));
    if (answer) return { text: answer[1], citationUrls: [] };
  }

  if (
    lines.length === 0 &&
    decision.route === "current_finance" &&
    /\bfortune\s*(?:100|500)\b/i.test(request.message)
  ) {
    return {
      text: "Specify the Fortune 100 or Fortune 500 and the ranking year, and I’ll keep every name and revenue position tied to that published table.",
      citationUrls: [],
      retryable: true,
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
      text: allPrivate
        ? `${privateList} ${
            entities.length === 1 ? "is" : "are"
          } privately held, so the relevant lens is business performance, financing, growth, and risk rather than public-share returns. Name the dimension you want analyzed.`
        : decision.route === "current_finance" || decision.route === "comparison"
          ? "Name the company, metric, and time period, and I’ll return only matched dated figures."
          : "Ask with a company, metric, or period and I’ll answer directly from verified evidence.",
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
        ? "The dated figures above do not establish a specific news catalyst."
        : "This snapshot reflects the dated figures and cited reporting above."
    );
  }
  if (hasSmuggledOffTopicTask(request.message)) {
    lines.unshift(
      "I kept this to the finance part:",
      ""
    );
  }
  const text = lines.join("\n");
  return {
    text: roundFiguresForDisplay(expandValidCitations(text, context.sources)),
    citationUrls: validCitationUrls(text, context.sources),
    retryable: true,
  };
}

export { buildDeterministicRankingReply };
export { humanAsOf, humanPublishedAt };
