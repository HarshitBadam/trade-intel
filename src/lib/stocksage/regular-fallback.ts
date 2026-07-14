import "server-only";

import {
  expandValidCitations,
  validCitationUrls,
} from "./citations";
import type { RegularContext } from "./retrieve";
import type {
  ChatReply,
  ChatRequest,
  EvidenceSource,
  FinanceEntity,
  RouteDecision,
} from "./types";

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
// market-session wording, never "2026-07-13T04:00:00.000Z".
function humanAsOf(asOf: string): string {
  if (!asOf.includes("T")) return asOf;
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) return asOf.split("T")[0];
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
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
      const period = /\blast (?:year|12 months)|\bover the last year\b/i.test(
        request.message
      )
        ? { label: "over the last year", value: quote.yearPct }
        : /\blast month|\bover the last month\b/i.test(request.message)
          ? { label: "over the last month", value: quote.monthPct }
          : /\blast week|\bover the last week\b/i.test(request.message)
            ? { label: "over the last week", value: quote.weekPct }
            : /\blast few days\b|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|\bthe other day\b/i.test(
                  request.message
                )
              ? { label: "over the last few sessions", value: quote.fewDaysPct }
              : { label: "in the latest session", value: quote.dayPct };
      const change =
        period.value === null
          ? "not available"
          : `${period.value >= 0 ? "+" : ""}${period.value.toFixed(2)}%`;
      lines.push(
        `- **${quote.ticker}** — $${quote.price.toFixed(2)} as of ${humanAsOf(quote.asOf)}; ${change} ${period.label}.`
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
          source.publishedAt ? ` (${source.publishedAt})` : ""
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
      return {
        text: `I don’t have current, like-for-like numbers for ${list} in front of me right now, and I’d rather not call this one from stale memory. Ask me again in a bit and I’ll run the comparison properly.`,
        citationUrls: [],
        retryable: true,
      };
    }
    if (missing.length > 0) {
      lines.push(
        "",
        `One gap: I couldn’t pull equivalent current evidence for ${list}, so treat this as partial.`
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
      text: "I can’t verify the current Fortune revenue ranking from a sufficiently recent source right now. I’d rather not guess at the names or revenue figures—please try again shortly.",
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
    return {
      text:
        decision.route === "current_finance" ||
        decision.route === "comparison"
          ? "I’m having trouble pulling verified current figures at this exact moment, and I don’t want to hand you numbers I can’t stand behind. Give it a minute and ask me again — nothing about your question is lost."
          : "I hit a snag putting that answer together just now. Ask me again in a moment and I’ll take another run at it.",
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
      `I can’t give you a verified call on ${dimension} this second — my analysis engine is briefly behind. Here’s what I can stand behind right now:`,
      ""
    );
    lines.push(
      "",
      `Ask again in a moment and I’ll take a proper run at ${dimension}.`
    );
  } else {
    lines.push(
      "",
      "That’s the verified picture I can stand behind right now — ask again in a bit and I should be able to take it further."
    );
  }
  const text = lines.join("\n");
  return {
    text: expandValidCitations(text, context.sources),
    citationUrls: validCitationUrls(text, context.sources),
    retryable: true,
  };
}
