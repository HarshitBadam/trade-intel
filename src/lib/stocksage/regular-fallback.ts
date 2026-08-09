import "server-only";

import {
  comparisonLead,
  buildDeterministicRankingReply,
  quoteWindowsForIntervals,
} from "./regular-comparison";
import { humanAsOf, humanPublishedAt } from "./regular-dates";
import { hasSmuggledOffTopicTask } from "./regular-guards";
import { finalizePublicationText } from "./publication";
import type { RegularContext } from "./evidence/retrieve";
import { addDays } from "./temporal";
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
  return `${sentence.slice(0, 260).replace(/[.,:; -]\s*$/, "")}${
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
    context.fundamentals.length === 0
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
  const historicalRequest = (context.plan.intervals ?? []).some(
    (interval) => interval.label !== "today" || interval.source !== "default"
  );

  if (decision.route !== "comparison" && context.quotes.length === 0) {
    for (const entity of entities.filter(
      (candidate) => candidate.ticker && !candidate.private
    )) {
      lines.push(
        `${casualName(entity.name)} is publicly listed as ${
          entity.ticker
        }, but a current quote was unavailable from the configured market-data feeds.`
      );
    }
  }

  if (context.quotes.length > 0 && decision.route !== "comparison") {
    lines.push("### Market snapshot");
    for (const quote of context.quotes) {
      const windows = quoteWindowsForIntervals(context.plan.intervals ?? []);
      const periods = windows.map((window) => ({
        label: window.label,
        metric: window.metric(quote),
        value: window.value(quote),
      }));
      if (periods.length === 0) {
        periods.push({
          label: "latest session",
          metric: {
            intervalKey: `fallback:${quote.asOf}`,
            startSession: quote.asOf,
            endSession: quote.asOf,
            firstSession: quote.asOf,
            lastSession: quote.asOf,
            price: quote.price,
            returnPct: quote.dayPct,
          },
          value: quote.dayPct,
        });
      }
      const displayedMetric = periods.find((period) => period.metric)?.metric;
      if (!displayedMetric) {
        const quoteLabel =
          quote.venue === "ASX" ? `ASX:${quote.ticker}` : quote.ticker;
        lines.push(
          `- **${quoteLabel}**, historical candles were unavailable for ${windows
            .map((window) => window.label)
            .join(" and ")}; no current-session figure was substituted.`
        );
        continue;
      }
      const changes = periods
        .filter(
          (period): period is typeof period & { value: number } =>
            period.value != null
        )
        .map(
          (period) =>
            `${period.label} ${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`
        )
        .join("; ");
      const changesSuffix = changes ? `, ${changes}` : "";
      const missingPeriods = periods
        .filter((period) => !period.metric)
        .map((period) => period.label);
      const missingSuffix =
        missingPeriods.length > 0
          ? ` Historical candles were unavailable for ${missingPeriods.join(
              " and "
            )}; no current-session figure was substituted.`
          : "";
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
          `- **${displayName}**, $${displayedMetric.price.toFixed(
            2
          )} at ${humanAsOf(displayedMetric.lastSession)}${
            quote.eod ? " close" : ""
          }${changesSuffix.replace(", latest session ", ", ")}. ${distinction}${missingSuffix}`
        );
      } else {
        const quoteLabel =
          quote.venue === "ASX" ? `ASX:${quote.ticker}` : quote.ticker;
        lines.push(
          `- **${quoteLabel}**, ${
            quote.isIndex
              ? `${displayedMetric.price.toFixed(2)} points`
              : `${quote.currency === "AUD" ? "A$" : "$"}${displayedMetric.price.toFixed(2)}`
          } as of ${humanAsOf(displayedMetric.lastSession)}${
            quote.eod ? " close (end-of-day)" : ""
          }${quote.sourceNote ? `; ${quote.sourceNote}` : ""}${changesSuffix}${
            quote.venue === "ASX" ? " on its native ASX listing in AUD" : ""
          }.${missingSuffix}`
        );
      }
    }
  }

  const comparisonNeedsArticles =
    decision.route !== "comparison" ||
    /\b(?:news|development|event|security|cyber|legal|regulat|lawsuit|catalyst|outlook)\b/i.test(
      request.message
    );
  const requestedIntervals = (context.plan.intervals ?? []).filter(
    (interval) => interval.label !== "today"
  );
  const periodSources =
    requestedIntervals.length === 0
      ? context.sources
      : context.sources.filter((source) => {
          const date = source.publishedAt?.slice(0, 10);
          return Boolean(
            date &&
              requestedIntervals.some(
                (interval) =>
                  date >= interval.startSession &&
                  date <= addDays(interval.endSession, 3)
              )
          );
        });
  if (periodSources.length > 0 && comparisonNeedsArticles) {
    if (lines.length > 0) lines.push("");
    const displayedSources =
      decision.route === "comparison"
        ? entities
            .map((entity) =>
              periodSources.find((source) => source.entityIds.includes(entity.id))
            )
            .filter(
              (source, index, list) =>
                Boolean(source) && list.indexOf(source) === index
            )
            .slice(0, 8)
        : periodSources.slice(0, 3);
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
    const hasStructuredFigure = (entity: FinanceEntity) =>
      Boolean(
        entity.ticker &&
          (context.quotes.some((quote) => quote.ticker === entity.ticker) ||
            context.fundamentals.some(
              (fundamental) => fundamental.ticker === entity.ticker
            ))
      );
    const asksPerformance =
      context.plan.explicitCriteria?.includes("performance") === true ||
      /\b(?:performance|returns?|up|down|done|doing|month|week|year|today)\b/i.test(
        request.message
      );
    if (
      asksPerformance &&
      context.quotes.length === 0 &&
      context.fundamentals.length === 0
    ) {
      const requestedNames = entities.map((entity) => casualName(entity.name));
      const requestedList =
        requestedNames.length > 1
          ? `${requestedNames.slice(0, -1).join(", ")} and ${
              requestedNames[requestedNames.length - 1]
            }`
          : requestedNames[0];
      const periods =
        context.plan.intervals?.map((interval) => interval.label).join(" and ") ??
        "the requested period";
      return {
        text: `No matched price-performance figures were available for ${requestedList} over ${periods}, so a verified ranking cannot be made. Retrieved articles do not substitute for a like-for-like return series.`,
        citationUrls: [],
        retryable: true,
      };
    }
    const outside = entities.filter(
      (entity) => !hasStructuredFigure(entity)
    );
    const partial = entities.filter(
      (entity) =>
        hasStructuredFigure(entity) &&
        context.coverage[entity.id] !== "covered"
    );
    const names = outside.map((entity) => casualName(entity.name));
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    if (outside.length > 0 && lines.length === 0) {
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
    if (outside.length > 0) {
      lines.push(
        "",
        `${list} ${
          outside.length === 1 ? "has" : "have"
        } no matched figure for this ranking; the comparison above includes only the dated figures actually shown.`
      );
    }
    if (partial.length > 0 && outside.length === 0) {
      lines.push(
        "",
        "The displayed price-performance figures are directly comparable. Broader valuation, growth, or risk evidence is partial where those metrics are not shown."
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
      context.quotes.length === 0 && periodSources.length > 0
        ? "The reporting above is separate from a current market quote."
        : periodSources.length === 0 &&
        /\b(?:news|development|catalyst|outlook|guidance|risks?|bull case|bear case)\b/i.test(
          request.message
        )
        ? "The dated figures above do not establish a specific news catalyst."
        : periodSources.length > 0
          ? "This snapshot reflects the dated figures and cited reporting above."
          : "This snapshot reflects the dated market figures above."
    );
  }
  if (hasSmuggledOffTopicTask(request.message)) {
    lines.unshift(
      "I kept this to the finance part:",
      ""
    );
  }
  const text = lines.join("\n");
  const finalized = finalizePublicationText(text, context.sources);
  return {
    text: finalized.text,
    citationUrls: finalized.citationUrls,
    retryable: true,
  };
}

export { buildDeterministicRankingReply };
export { humanAsOf, humanPublishedAt };
