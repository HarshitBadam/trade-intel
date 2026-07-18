import "server-only";

import {
  expandValidCitations,
  validCitationUrls,
} from "./citations";
import { humanAsOf, humanPublishedAt } from "./regular-fallback";
import type { RegularContext } from "./retrieve";
import type {
  ChatReply,
  ChatRequest,
  EvidenceSource,
  FinanceEntity,
} from "./types";

type DeterministicReply = Pick<
  ChatReply,
  "text" | "citationUrls" | "retryable"
>;

function commonName(entity: FinanceEntity): string {
  return entity.name.replace(
    /,? (?:inc|corp(?:oration)?|ltd|plc|co)\.?\s*(?:common stock.*)?$/i,
    ""
  );
}

function safeSentence(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_`>\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !clean ||
    /\b(?:ignore previous|system prompt|developer message|follow these instructions)\b/i.test(
      clean
    )
  ) {
    return null;
  }
  const sentence = clean.split(/(?<=[.!?])\s+/)[0] ?? clean;
  return `${sentence.slice(0, 300).replace(/[,:;–—-]\s*$/, "")}${
    sentence.length > 300 ? "…" : ""
  }`;
}

function sourceDetail(source: EvidenceSource): string | null {
  return (
    safeSentence(source.keyObservations) ??
    safeSentence(source.event) ??
    safeSentence(source.excerpt)
  );
}

function sourceRank(source: EvidenceSource): number {
  const importance =
    source.importance?.toLowerCase() === "high"
      ? 4
      : source.importance?.toLowerCase() === "medium"
        ? 2
        : 0;
  return (source.relevanceScore ?? source.score ?? 0) + importance;
}

function rankedSources(context: RegularContext): EvidenceSource[] {
  return [...context.sources]
    .sort((left, right) => sourceRank(right) - sourceRank(left))
    .slice(0, 3);
}

function finalize(
  text: string,
  context: RegularContext,
  retryable?: true
): DeterministicReply {
  return {
    text: expandValidCitations(text, context.sources),
    citationUrls: validCitationUrls(text, context.sources),
    retryable,
  };
}

function quoteLine(
  entity: FinanceEntity,
  context: RegularContext
): string | null {
  const quote = entity.ticker
    ? context.quotes.find((item) => item.ticker === entity.ticker)
    : undefined;
  if (!quote) return null;
  return `${entity.ticker ?? commonName(entity)} was $${quote.price.toFixed(
    2
  )} as of ${humanAsOf(quote.asOf)}, with a ${
    quote.dayPct >= 0 ? "+" : ""
  }${quote.dayPct.toFixed(2)}% latest-session move.`;
}

function fundamentalsFrame(
  entity: FinanceEntity,
  context: RegularContext
): { bull: string[]; bear: string[] } {
  const item = entity.ticker
    ? context.fundamentals.find(
        (fundamental) => fundamental.ticker === entity.ticker
      )
    : undefined;
  if (!item) return { bull: [], bear: [] };
  const bull: string[] = [];
  const bear: string[] = [];
  if (item.revenueGrowthTtmYoy != null) {
    bull.push(
      `TTM revenue growth is ${
        item.revenueGrowthTtmYoy >= 0 ? "+" : ""
      }${item.revenueGrowthTtmYoy.toFixed(1)}% year over year.`
    );
  }
  if (item.peTtm != null) {
    const line = `The shares trade at ${item.peTtm.toFixed(1)}× trailing earnings.`;
    if (item.peTtm >= 35) bear.push(line);
    else bull.push(line);
  }
  if (item.beta != null) {
    bear.push(
      `Beta is ${item.beta.toFixed(
        1
      )}, so the stock has historically moved more sharply than the broad market.`
    );
  }
  return { bull, bear };
}

function renderLatest(
  request: ChatRequest,
  entity: FinanceEntity,
  context: RegularContext
): DeterministicReply {
  const sources = rankedSources(context).slice(0, 2);
  if (sources.length === 0) {
    const alreadySaidNoEvent = request.history
      .filter((turn) => turn.role === "ai")
      .slice(-2)
      .some((turn) => /no (?:specific|qualifying) (?:news |current )?(?:catalyst|event|development)/i.test(turn.text));
    const quote = alreadySaidNoEvent ? null : quoteLine(entity, context);
    const frame = fundamentalsFrame(entity, context);
    const implication =
      frame.bull.length || frame.bear.length
        ? `The numbers imply a growth story with meaningful valuation or volatility sensitivity: ${[
            ...frame.bull.slice(0, 1),
            ...frame.bear.slice(0, 1),
          ].join(" ")}`
        : "";
    return finalize(
      [
        `No qualifying current ${commonName(entity)} event was present in the available reporting.`,
        quote,
        implication,
      ]
        .filter(Boolean)
        .join(" "),
      context,
      true
    );
  }
  const lines = sources.map((source) => {
    const date = source.publishedAt
      ? humanPublishedAt(source.publishedAt)
      : "Date not supplied";
    const detail = sourceDetail(source);
    return `- **${date} — ${source.title}**${
      detail ? `: ${detail}` : ""
    } [${source.id}]`;
  });
  return finalize(
    `${commonName(entity)}’s strongest current developments are:\n${lines.join(
      "\n"
    )}`,
    context
  );
}

function renderMostImportant(
  entity: FinanceEntity,
  context: RegularContext
): DeterministicReply | null {
  const source = rankedSources(context)[0];
  if (!source) return null;
  const detail = sourceDetail(source);
  const sentiment = source.sentiment
    ? `The article’s investor read-through is ${source.sentiment.toLowerCase()}.`
    : "";
  return finalize(
    `The development that matters most is **${source.title}**${
      source.publishedAt ? ` (${humanPublishedAt(source.publishedAt)})` : ""
    }. ${detail ?? "It is the strongest entity- and criterion-matched event in the current reporting."} [${source.id}] ${sentiment}`.trim(),
    context
  );
}

function renderOutlook(
  entity: FinanceEntity,
  context: RegularContext,
  summary = false
): DeterministicReply {
  const frame = fundamentalsFrame(entity, context);
  const sources = rankedSources(context);
  const catalyst = sources.find((source) =>
    source.criteria.some((criterion) =>
      ["outlook", "growth", "current developments"].includes(criterion)
    )
  );
  const risk = sources.find((source) => source.criteria.includes("risk"));
  const bull = [
    ...frame.bull,
    catalyst
      ? `${sourceDetail(catalyst) ?? catalyst.title} [${catalyst.id}]`
      : null,
  ].filter(Boolean);
  const bear = [
    ...frame.bear,
    risk ? `${sourceDetail(risk) ?? risk.title} [${risk.id}]` : null,
  ].filter(Boolean);
  const lines = [
    `**Bull case:** ${
      bull.join(" ") ||
      "No qualifying current catalyst or structured growth figure is available."
    }`,
    `**Bear case:** ${
      bear.join(" ") ||
      "No qualifying current risk event or structured risk figure is available."
    }`,
  ];
  if (frame.bull.length > 0 || frame.bear.length > 0) {
    lines.push(
      `The numbers imply that stronger growth can support the thesis, while the earnings multiple and beta determine how much disappointment risk investors are taking.`
    );
  }
  if (summary) {
    const bullSummary =
      frame.bull[0] ??
      (catalyst ? sourceDetail(catalyst) ?? catalyst.title : "No qualifying catalyst");
    const bearSummary =
      frame.bear[0] ??
      (risk ? sourceDetail(risk) ?? risk.title : "No qualifying risk event");
    const citations = [
      frame.bull.length === 0 && catalyst ? `[${catalyst.id}]` : "",
      frame.bear.length === 0 && risk && risk.id !== catalyst?.id
        ? `[${risk.id}]`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return finalize(
      `Plainly: bull case — ${bullSummary
        .replace(/^TTM /, "")
        .replace(/\.$/, "")
        .toLowerCase()}; bear case — ${bearSummary
        .replace(/\.$/, "")
        .toLowerCase()}. The trade-off is rapid growth against valuation and volatility sensitivity. ${citations}`.trim(),
      context,
      sources.length === 0 ? true : undefined
    );
  }
  return finalize(lines.join("\n\n"), context, sources.length === 0 ? true : undefined);
}

export function buildGroundedDeterministicReply(
  request: ChatRequest,
  entities: FinanceEntity[],
  context: RegularContext
): DeterministicReply | null {
  if (entities.length !== 1) return null;
  const entity = entities[0];
  const message = request.message;
  if (
    /\b(?:which|what)\b.{0,40}\bdevelopment\b.{0,30}\bmatters?\b/i.test(
      message
    )
  ) {
    return renderMostImportant(entity, context) ?? renderLatest(request, entity, context);
  }
  if (
    /\b(?:bull|bear|catalysts?|risks?|outlook|next[- ]quarter|research)\b/i.test(
      message
    )
  ) {
    return renderOutlook(
      entity,
      context,
      /\bsummari[sz]e\b|\bplainly\b/i.test(message)
    );
  }
  if (/\b(?:latest|recent|current)\b.{0,30}\b(?:news|developments?|events?|update)\b|\bnews\b/i.test(message)) {
    return renderLatest(request, entity, context);
  }
  if (entity.private && context.sources.length > 0) {
    const source = rankedSources(context)[0];
    return finalize(
      `${commonName(entity)} is privately held, so there is no public share-price or listed-company valuation data to compare. ${sourceDetail(source) ?? source.title} [${source.id}]`,
      context
    );
  }
  return null;
}
